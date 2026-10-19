import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FieldValue } from "firebase-admin/firestore";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import {
  TICKER_UNIVERSE_ADAPTER,
  type TickerUniverseAdapter,
} from "../adapters/types";
import { SyncRegistry } from "../common/sync-registry.service";
import { DelistedTickersService } from "../common/delisted-tickers.service";
import { PolygonService } from "../vendors/polygon/polygon.service";

const JOB_NAME = "ticker-universe";
/**
 * Delisting guards. A pull that comes back short — the vendor paging out early
 * or a soft error — would otherwise "delist" thousands of live symbols and hide
 * them everywhere. Below this share of last run's pull, or above this many
 * symbols dropping out since last run (a normal week is ~5-20), nothing is
 * marked.
 */
const MIN_PULL_RATIO = 0.95;
const MAX_DELISTINGS_PER_RUN = 200;
/**
 * A run stamps every doc it upserts within seconds; docs stamped more than this
 * before the newest stamp were not in last run's pull. They are the backlog —
 * symbols that dropped out before delisting detection existed (353 when it
 * shipped, AACB among them) — and are exempt from the cap above: the cap
 * measures what THIS pull lost, and they were lost long ago.
 */
const LAST_PULL_WINDOW_MS = 60 * 60_000;
/**
 * Delisting lookups per run for the backlog, oldest first. At ~300ms a call and
 * LOOKUP_CONCURRENCY in flight this stays well inside the scheduler's 300s
 * deadline; anything left over is picked up by the next run.
 */
const MAX_BACKLOG_CHECKS_PER_RUN = 500;
const LOOKUP_CONCURRENCY = 8;
// 2 writes per symbol, under Firestore's 500-write batch cap.
const MARKS_PER_BATCH = 200;

@Injectable()
export class TickerUniverseJob implements OnModuleInit {
  private readonly logger = new Logger(TickerUniverseJob.name);

  constructor(
    @Inject(TICKER_UNIVERSE_ADAPTER)
    private readonly universe: TickerUniverseAdapter,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly polygon: PolygonService,
    private readonly delisted: DelistedTickersService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["tickers"],
      cronExpression: "0 3 * * 0",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const result = await this.universe.fetchAllTickers(true);
      const tickers = result.data;
      if (tickers.length === 0) {
        throw new Error(
          `${result.source} returned zero tickers — check the API key / plan access to the reference-tickers endpoint`,
        );
      }
      const docs = tickers.map((t) => ({
        id: t.ticker,
        data: {
          ticker: t.ticker,
          name: t.name,
          nameLower: t.name ? t.name.toLowerCase() : null,
          searchTokens: t.name
            ? Array.from(
                new Set([
                  ...t.name
                    .toLowerCase()
                    .split(/[^a-z0-9]+/)
                    .filter(Boolean),
                  t.ticker.toLowerCase(),
                ]),
              )
            : [t.ticker.toLowerCase()],
          market: t.market,
          locale: t.locale,
          primaryExchange: t.primaryExchange,
          type: t.type,
          active: t.active,
          currencyName: t.currencyName,
          // FMP-sourced rows carry no CIK/FIGI; omitting the null keeps the
          // value an earlier Polygon pull stored (the batch write merges).
          ...(t.cik ? { cik: t.cik } : {}),
          ...(t.compositeFigi ? { compositeFigi: t.compositeFigi } : {}),
          ...(t.shareClassFigi ? { shareClassFigi: t.shareClassFigi } : {}),
          source: result.source,
          updatedAt: new Date().toISOString(),
        },
      }));
      // Read BEFORE the upsert so last run's active set and stamps are intact.
      const [prevActive, prevDelisted] = await Promise.all([
        this.firebase.firestore
          .collection("tickers")
          .where("active", "==", true)
          .select("updatedAt")
          .get(),
        this.firebase.firestore
          .collection("tickers")
          .where("active", "==", false)
          .select()
          .get(),
      ]);
      await chunkedBatchSet(this.firebase.firestore, "tickers", docs);
      const fetchedIds = new Set(tickers.map((t) => t.ticker));
      await this.restoreRelisted(
        prevDelisted.docs.map((d) => d.id).filter((id) => fetchedIds.has(id)),
      );
      const delisted = await this.markDelisted(
        prevActive.docs.map((d) => {
          const u: unknown = d.get("updatedAt");
          return { id: d.id, updatedAt: typeof u === "string" ? u : null };
        }),
        fetchedIds,
      );
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      return { count: docs.length, delisted };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Retires symbols that left the active list. The upsert above only ever
   * touches symbols the vendor still lists, so a delisted one used to keep
   * `active: true` forever — and keep its `companies` doc, which every list
   * and per-ticker job reads. AACB (delisted 2026-08-20) was still on screen
   * with its last close re-stamped daily, like 14 others.
   *
   * Each drop-out is confirmed against a vendor delisting record (FMP first,
   * Polygon as backup) before it is marked; one that merely went missing from
   * this pull is left alone. Marking sets `active: false` + `delistedAt`
   * (hidden everywhere via DelistedTickersService, and dropped from activeUniverse so the per-ticker
   * jobs stop) and soft-deletes the `companies` doc: it is kept, stamped
   * `delisted: true` + `delistedAt`, never removed. A symbol that relists comes
   * back through the upsert as `active: true` and restoreRelisted lifts the
   * stamp.
   *
   * The short-pull guards judge only symbols in last run's pull (see
   * LAST_PULL_WINDOW_MS). Older stale symbols — the backlog — are checked
   * oldest first, a bounded number per run; each still needs a delisting record.
   */
  private async markDelisted(
    prevActive: Array<{ id: string; updatedAt: string | null }>,
    fetched: Set<string>,
  ): Promise<string[]> {
    const dropped = prevActive.filter((t) => !fetched.has(t.id));
    if (dropped.length === 0) return [];

    const newest = prevActive.reduce<string | null>(
      (m, t) => (t.updatedAt && (!m || t.updatedAt > m) ? t.updatedAt : m),
      null,
    );
    // No stamps at all: every doc counts as last run's pull, as before.
    const cutoff =
      newest === null
        ? null
        : new Date(Date.parse(newest) - LAST_PULL_WINDOW_MS).toISOString();
    const inLastPull = (t: { updatedAt: string | null }) =>
      cutoff === null || (t.updatedAt !== null && t.updatedAt >= cutoff);
    const lastPullSize = prevActive.filter(inLastPull).length;
    const newlyDropped = dropped.filter(inLastPull);
    const backlog = dropped
      .filter((t) => !inLastPull(t))
      .sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));

    if (
      fetched.size < lastPullSize * MIN_PULL_RATIO ||
      newlyDropped.length > MAX_DELISTINGS_PER_RUN
    ) {
      this.logger.warn(
        `ticker-universe: ${newlyDropped.length} symbols dropped out of a ${fetched.size}-symbol pull ` +
          `(last pull ${lastPullSize}) — looks like a short pull, NOT marking any delisted`,
      );
      return [];
    }

    const toCheck = [
      ...newlyDropped,
      ...backlog.slice(0, MAX_BACKLOG_CHECKS_PER_RUN),
    ].map((t) => t.id);
    const found = new Map<string, string | null>();
    let next = 0;
    const worker = async () => {
      while (next < toCheck.length) {
        const t = toCheck[next++];
        try {
          const rec = await this.polygon.getDelisting(t);
          if (rec) found.set(t, rec.delistedAt);
        } catch (err) {
          this.logger.warn(
            `delisting lookup failed for ${t}: ${(err as Error).message}`,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: LOOKUP_CONCURRENCY }, worker));

    const db = this.firebase.firestore;
    const confirmed = toCheck.filter((t) => found.has(t));
    const hasCompany = await this.existingCompanies(confirmed);
    const now = new Date().toISOString();
    for (let i = 0; i < confirmed.length; i += MARKS_PER_BATCH) {
      const batch = db.batch();
      for (const t of confirmed.slice(i, i + MARKS_PER_BATCH)) {
        const delistedAt = found.get(t) ?? null;
        batch.set(
          db.collection("tickers").doc(t),
          { active: false, delistedAt, updatedAt: now },
          { merge: true },
        );
        // Soft delete: the companies doc is kept, stamped, and hidden by the
        // delisted set like every other read. Only an existing doc is stamped —
        // a merge onto a missing one would create a stub the collection-wide
        // readers would then pick up.
        if (hasCompany.has(t)) {
          batch.set(
            db.collection("companies").doc(t),
            { delisted: true, delistedAt, updatedAt: now },
            { merge: true },
          );
        }
      }
      await batch.commit();
    }
    if (confirmed.length) {
      this.delisted.invalidate();
      this.logger.log(
        `ticker-universe: marked ${confirmed.length} delisted: ${confirmed.join(", ")}`,
      );
    }
    const deferred = backlog.length - Math.min(backlog.length, MAX_BACKLOG_CHECKS_PER_RUN);
    if (deferred) {
      this.logger.log(
        `ticker-universe: ${deferred} older drop-out(s) left for the next run`,
      );
    }
    const unconfirmed = toCheck.length - confirmed.length;
    if (unconfirmed) {
      this.logger.warn(
        `ticker-universe: ${unconfirmed} dropped symbol(s) had no FMP or Polygon delisting record — left active`,
      );
    }
    return confirmed;
  }

  /**
   * A symbol marked delisted on an earlier run that is back in the active
   * list. The upsert has already set its `tickers` doc active again; this
   * lifts the soft-delete stamp off its kept `companies` doc.
   */
  private async restoreRelisted(relisted: string[]): Promise<void> {
    if (relisted.length === 0) return;
    const db = this.firebase.firestore;
    const hasCompany = await this.existingCompanies(relisted);
    const ids = relisted.filter((t) => hasCompany.has(t));
    for (let i = 0; i < ids.length; i += MARKS_PER_BATCH) {
      const batch = db.batch();
      for (const t of ids.slice(i, i + MARKS_PER_BATCH)) {
        batch.set(
          db.collection("companies").doc(t),
          { delisted: FieldValue.delete(), delistedAt: FieldValue.delete() },
          { merge: true },
        );
      }
      await batch.commit();
    }
    this.delisted.invalidate();
    this.logger.log(`ticker-universe: ${relisted.length} relisted: ${relisted.join(", ")}`);
  }

  /** Which of `tickers` have a `companies` doc. */
  private async existingCompanies(tickers: string[]): Promise<Set<string>> {
    const db = this.firebase.firestore;
    const out = new Set<string>();
    for (let i = 0; i < tickers.length; i += 300) {
      const snaps = await db.getAll(
        ...tickers.slice(i, i + 300).map((t) => db.collection("companies").doc(t)),
      );
      for (const s of snaps) if (s.exists) out.add(s.id);
    }
    return out;
  }
}
