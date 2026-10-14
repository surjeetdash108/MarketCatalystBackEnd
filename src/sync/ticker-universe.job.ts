import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
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
 * them everywhere. Below this share of last run's active count, or above this
 * many drop-outs in one run (a normal week is ~5-20), nothing is marked.
 */
const MIN_PULL_RATIO = 0.95;
// Also keeps the one batch below Firestore's 500-write cap (2 writes each).
const MAX_DELISTINGS_PER_RUN = 200;

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
          cik: t.cik,
          compositeFigi: t.compositeFigi,
          shareClassFigi: t.shareClassFigi,
          source: result.source,
          updatedAt: new Date().toISOString(),
        },
      }));
      // Read BEFORE the upsert so last run's active set is still intact.
      const prevActive = await this.firebase.firestore
        .collection("tickers")
        .where("active", "==", true)
        .select()
        .get();
      await chunkedBatchSet(this.firebase.firestore, "tickers", docs);
      const delisted = await this.markDelisted(
        prevActive.docs.map((d) => d.id),
        new Set(tickers.map((t) => t.ticker)),
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
   * Each drop-out is confirmed against Polygon's inactive record before it is
   * marked; one that merely went missing from this pull is left alone. Marking
   * sets `active: false` + `delistedAt` (hidden everywhere via
   * DelistedTickersService) and deletes the `companies` doc so the per-ticker
   * jobs and lists stop carrying it. A symbol that relists comes back through
   * the upsert as `active: true`.
   */
  private async markDelisted(
    prevActive: string[],
    fetched: Set<string>,
  ): Promise<string[]> {
    const dropped = prevActive.filter((t) => !fetched.has(t));
    if (dropped.length === 0) return [];
    if (
      fetched.size < prevActive.length * MIN_PULL_RATIO ||
      dropped.length > MAX_DELISTINGS_PER_RUN
    ) {
      this.logger.warn(
        `ticker-universe: ${dropped.length} symbols dropped out of a ${fetched.size}-symbol pull ` +
          `(was ${prevActive.length}) — looks like a short pull, NOT marking any delisted`,
      );
      return [];
    }

    const db = this.firebase.firestore;
    const confirmed: string[] = [];
    const batch = db.batch();
    const now = new Date().toISOString();
    for (const t of dropped) {
      let rec: { delistedAt: string | null } | null = null;
      try {
        rec = await this.polygon.getDelisting(t);
      } catch (err) {
        this.logger.warn(
          `delisting lookup failed for ${t}: ${(err as Error).message}`,
        );
      }
      if (!rec) continue;
      batch.set(
        db.collection("tickers").doc(t),
        { active: false, delistedAt: rec.delistedAt, updatedAt: now },
        { merge: true },
      );
      batch.delete(db.collection("companies").doc(t));
      confirmed.push(t);
    }
    if (confirmed.length) {
      await batch.commit();
      this.delisted.invalidate();
      this.logger.log(
        `ticker-universe: marked ${confirmed.length} delisted: ${confirmed.join(", ")}`,
      );
    }
    const unconfirmed = dropped.length - confirmed.length;
    if (unconfirmed) {
      this.logger.warn(
        `ticker-universe: ${unconfirmed} dropped symbol(s) had no Polygon delisting record — left active`,
      );
    }
    return confirmed;
  }
}
