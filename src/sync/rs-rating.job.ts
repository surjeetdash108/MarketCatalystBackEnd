import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  type PendingWrite,
} from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { activeUniverse } from "../common/ticker-universe";
import { SyncRegistry } from "../common/sync-registry.service";
import { etDate } from "../common/market-calendar.util";

const JOB_NAME = "rs-rating";
/** A year of sessions plus room for gaps; computeRsScoreDated keeps only the last year. */
const BARS_PER_TICKER = 300;
const QUARTER_DAYS = 63;
/** Two quarters of history: a score from one quarter isn't comparable with a full year's. */
const MIN_BARS_REQUIRED = 2 * QUARTER_DAYS + 1;
const QUARTER_WEIGHTS = [0.4, 0.2, 0.2, 0.2];
const MIN_QUARTERS = 2;
/** Calendar quarter for the dated score, and how far a bar may sit from its anchor date. */
const QUARTER_CAL_DAYS = 91;
const ANCHOR_SLACK_DAYS = 10;
const DAY_MS = 86_400_000;
/** A 2.5x+ move that reverts within this many sessions is a bad print, not a move. */
const SPIKE_REVERT_SESSIONS = 10;

/** Polygon ticker types RS ranks: common stock and ADRs. Unknown (no reference row) passes. */
export function rsEligibleType(type: string | null | undefined): boolean {
  if (!type) return true;
  return type === "CS" || type === "ADRC";
}

/**
 * False when a close series can't be a single, consistently adjusted stock: a
 * one-day move beyond 4x either way (an unadjusted reverse split — LOBO, BRTX —
 * or a reused symbol joining another security's history — BNY $10.20 →
 * $138.98, SPCX), or a 2.5x+ spike that reverts within ten sessions (a bad
 * print — TJGC held 6.57, then 2.19 for six sessions, then 6.11). Such a history would rank 99 or 1 for
 * reasons that have nothing to do with relative strength.
 */
export function rsHistoryConsistent(closes: number[]): boolean {
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!(prev > 0) || !(cur > 0)) return false;
    const r = cur / prev;
    if (r > 4 || r < 0.25) return false;
    if (r > 2.5 || r < 0.4) {
      for (let k = i + 1; k <= Math.min(i + SPIKE_REVERT_SESSIONS, closes.length - 1); k++) {
        if (Math.abs(closes[k] / prev - 1) < 0.25) return false;
      }
    }
  }
  return true;
}

const weighted = (quarterlyReturns: number[]): number | null => {
  if (quarterlyReturns.length < MIN_QUARTERS) return null;
  const weights = QUARTER_WEIGHTS.slice(0, quarterlyReturns.length);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  return quarterlyReturns.reduce((sum, r, i) => sum + r * weights[i], 0) / weightSum;
};

/**
 * Raw relative-strength score = weighted trailing quarterly returns (40/20/20/20)
 * over a gap-free close series (a fresh vendor fetch), quarters of 63 sessions.
 * Pure so the on-demand first-time company sync can score a brand-new ticker
 * from the same bars, then rank it against the stored universe scores with
 * rsPercentile below. Null with under two quarters of history or an
 * inconsistent series (rsHistoryConsistent). `closes` ascending by date.
 */
export function computeRsScore(closes: number[]): number | null {
  if (closes.length < MIN_BARS_REQUIRED || !rsHistoryConsistent(closes)) return null;
  const quarterlyReturns: number[] = [];
  for (let q = 0; q < 4; q++) {
    const endIdx = closes.length - 1 - q * QUARTER_DAYS;
    const startIdx = endIdx - QUARTER_DAYS;
    if (startIdx < 0) break;
    quarterlyReturns.push((closes[endIdx] - closes[startIdx]) / closes[startIdx]);
  }
  return weighted(quarterlyReturns);
}

/**
 * The same score from stored, dated daily bars, with calendar quarters (91 days
 * back from today) so missing sessions don't stretch the window: 260 stored bars
 * once spanned 2023–2026 for MF. Only the last year counts; each quarter's
 * close is the last bar on or before its anchor date (within 10 days), and the
 * newest bar must be recent. Null with under two quarters or an inconsistent
 * series.
 */
export function computeRsScoreDated(bars: Array<{ date: string; close: number }>, today: string): number | null {
  const end = Date.parse(`${today}T00:00:00Z`);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const yearAgo = iso(end - 4 * QUARTER_CAL_DAYS * DAY_MS - ANCHOR_SLACK_DAYS * DAY_MS);
  const rows = bars
    .filter((b) => b.date && b.date >= yearAgo && b.date <= today && Number.isFinite(b.close))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (rows.length < 2 || !rsHistoryConsistent(rows.map((b) => b.close))) return null;
  const closeAt = (anchorMs: number): number | null => {
    const anchor = iso(anchorMs);
    const floor = iso(anchorMs - ANCHOR_SLACK_DAYS * DAY_MS);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].date <= anchor) return rows[i].date >= floor ? rows[i].close : null;
    }
    return null;
  };
  const points: number[] = [];
  for (let q = 0; q <= 4; q++) {
    const c = closeAt(end - q * QUARTER_CAL_DAYS * DAY_MS);
    if (c == null) break;
    points.push(c);
  }
  const quarterlyReturns: number[] = [];
  for (let q = 0; q + 1 < points.length; q++) quarterlyReturns.push(points[q] / points[q + 1] - 1);
  return weighted(quarterlyReturns);
}

/**
 * Percentile (1–99) of one `score` within the universe's stored raw scores,
 * matching run()'s ranking formula (rank i of n, mapped 1..99). The score is
 * treated as inserted into the distribution, so it needs no prior membership.
 */
export function rsPercentile(score: number, universeScores: number[]): number {
  const n = universeScores.length + 1;
  if (n === 1) return 99;
  const i = universeScores.filter((s) => s < score).length;
  return Math.round(1 + (i / (n - 1)) * 98);
}

@Injectable()
export class RsRatingJob implements OnModuleInit {
  private readonly logger = new Logger(RsRatingJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["companies"],
      cronExpression: "0 4 * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  private async computeScore(ticker: string, today: string) {
    const snap = await this.firebase.firestore
      .collection("ohlcv_bars")
      .where("ticker", "==", ticker)
      .orderBy("barDate", "desc")
      .limit(BARS_PER_TICKER)
      .get();
    const bars = snap.docs.map((d) => {
      const x = d.data();
      return { date: String(x.barDate ?? ""), close: Number(x.close) };
    });
    return computeRsScoreDated(bars, today);
  }

  /** Polygon ticker type per symbol (tickers/{T}.type); missing when there is no reference row. */
  private async tickerTypes(tickers: string[]): Promise<Map<string, string | null>> {
    const db = this.firebase.firestore;
    const out = new Map<string, string | null>();
    for (let i = 0; i < tickers.length; i += 300) {
      const chunk = tickers.slice(i, i + 300);
      const snaps = await db.getAll(...chunk.map((t) => db.collection("tickers").doc(t)));
      snaps.forEach((snap, j) => {
        const type = snap.exists ? snap.data()?.type : null;
        out.set(chunk[j], typeof type === "string" ? type : null);
      });
    }
    return out;
  }

  async run() {
    try {
      const universe = await activeUniverse(this.firebase.firestore);
      if (universe.length === 0) {
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { count: 0, note: "no active tickers yet" };
      }
      const raw = [];
      let skipped = 0;
      const today = etDate();
      // Rank stocks against stocks: leveraged/inverse ETFs, funds, preferreds
      // and units crowded both ends of the scale (CBRZ 2X short at 99).
      const types = await this.tickerTypes(universe).catch(() => new Map<string, string | null>());
      for (const ticker of universe) {
        if (!rsEligibleType(types.get(ticker))) {
          skipped++;
          continue;
        }
        try {
          const score = await this.computeScore(ticker, today);
          if (score == null) {
            skipped++;
            continue;
          }
          raw.push({ ticker, score });
        } catch (err) {
          this.logger.error(
            `Failed computing RS score for ${ticker}: ${err.message}`,
          );
          skipped++;
        }
      }
      if (raw.length === 0) {
        this.logger.warn(
          `No tickers had enough ohlcv_bars history to score (${skipped}/${universe.length} skipped) — has stock-history.job.ts run yet?`,
        );
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { scored: 0, skipped };
      }
      raw.sort((a, b) => a.score - b.score);
      const n = raw.length;
      const writes: PendingWrite[] = [];
      const col = this.firebase.firestore.collection("companies");
      raw.forEach((r, i) => {
        const percentile = n === 1 ? 99 : Math.round(1 + (i / (n - 1)) * 98);
        writes.push({
          ref: col.doc(r.ticker),
          data: {
            rsRating: percentile,
            // Raw score stored so the on-demand first-time company sync can rank
            // a brand-new ticker against this distribution (see rsPercentile /
            // ondemand.service) instead of waiting for this nightly sweep.
            rsScore: r.score,
            rsRatingUpdatedAt: new Date().toISOString(),
          },
        });
      });
      // A rating nobody refreshes is wrong by tomorrow: clear it on every doc
      // this run didn't score (ineligible type, short or inconsistent history,
      // or no longer in the universe).
      const scored = new Set(raw.map((r) => r.ticker));
      const rated = await col.where("rsRating", ">=", 0).select().get();
      const clearedAt = new Date().toISOString();
      for (const d of rated.docs) {
        if (scored.has(d.id)) continue;
        writes.push({ ref: col.doc(d.id), data: { rsRating: null, rsScore: null, rsRatingUpdatedAt: clearedAt } });
      }
      await batchSetWithCreatedAt(this.firebase.firestore, writes);
      await this.meta.record(JOB_NAME, { ok: true, count: raw.length });
      return { scored: raw.length, skipped };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
