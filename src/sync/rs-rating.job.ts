import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  type PendingWrite,
} from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { activeUniverse } from "../common/ticker-universe";
import { SyncRegistry } from "../common/sync-registry.service";

const JOB_NAME = "rs-rating";
const BARS_PER_TICKER = 260;
const QUARTER_DAYS = 63;
const MIN_BARS_REQUIRED = 65;
const QUARTER_WEIGHTS = [0.4, 0.2, 0.2, 0.2];

/**
 * Raw relative-strength score = weighted trailing quarterly returns. Pure so the
 * on-demand first-time company sync can score a brand-new ticker from the same
 * bars, then rank it against the stored universe scores with rsPercentile below
 * — the two together let a ticker earn an RS rating on first view instead of
 * waiting for the nightly sweep. Returns null when history is too short (matches
 * the sweep's skip). `closes` ascending by date.
 */
export function computeRsScore(closes: number[]): number | null {
  if (closes.length < MIN_BARS_REQUIRED) return null;
  const quarterlyReturns: number[] = [];
  for (let q = 0; q < 4; q++) {
    const endIdx = closes.length - 1 - q * QUARTER_DAYS;
    const startIdx = endIdx - QUARTER_DAYS;
    if (startIdx < 0) break;
    const startPrice = closes[startIdx];
    const endPrice = closes[endIdx];
    if (startPrice <= 0) break;
    quarterlyReturns.push((endPrice - startPrice) / startPrice);
  }
  if (quarterlyReturns.length === 0) return null;
  const weights = QUARTER_WEIGHTS.slice(0, quarterlyReturns.length);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  return (
    quarterlyReturns.reduce((sum, r, i) => sum + r * weights[i], 0) / weightSum
  );
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

  private async computeScore(ticker: string) {
    const snap = await this.firebase.firestore
      .collection("ohlcv_bars")
      .where("ticker", "==", ticker)
      .orderBy("barDate", "desc")
      .limit(BARS_PER_TICKER)
      .get();
    const closes = snap.docs.map((d) => d.data().close).reverse();
    return computeRsScore(closes);
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
      for (const ticker of universe) {
        try {
          const score = await this.computeScore(ticker);
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
