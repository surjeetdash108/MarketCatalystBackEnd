import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  type PendingWrite,
} from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { activeUniverse } from "../common/ticker-universe";
import { SyncRegistry } from "../common/sync-registry.service";

const JOB_NAME = "tech-rating";
const BARS_TO_READ = 130;
const MIN_BARS = 65;
const MOMENTUM_DAYS = 63;
const SMA_PERIOD = 50;

function sma(values: number[], n: number) {
  if (values.length < n) return null;
  const slice = values.slice(values.length - n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

function rsi14(closes: number[], period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function percentiles(rows, pick) {
  const sorted = [...rows].sort((a, b) => pick(a) - pick(b));
  const n = sorted.length;
  const out = new Map();
  sorted.forEach((r, i) => {
    out.set(r.ticker, n === 1 ? 100 : (i / (n - 1)) * 100);
  });
  return out;
}

/** The three raw components of the tech rating for one ticker. */
export interface TechComponents {
  momentum: number;
  trend: number;
  rsi: number;
}

/**
 * Raw tech-rating components (63-day momentum, price-vs-SMA50 trend, RSI14) from
 * a close series. Pure so the on-demand first-time company sync can derive them
 * from the same bars, store them on the doc, and rank a new ticker against the
 * universe with techRatingFromComponents below — giving a tech rating on first
 * view instead of waiting for the nightly sweep. `closes` ascending by date;
 * null when history is too short (matches the sweep's skip).
 */
export function computeTechComponents(closes: number[]): TechComponents | null {
  if (closes.length < MIN_BARS) return null;
  const price = closes[closes.length - 1];
  const past = closes[closes.length - 1 - MOMENTUM_DAYS];
  const ma50 = sma(closes, SMA_PERIOD);
  const rsiVal = rsi14(closes);
  if (past == null || past <= 0 || ma50 == null || ma50 <= 0 || rsiVal == null) {
    return null;
  }
  return { momentum: (price - past) / past, trend: price / ma50 - 1, rsi: rsiVal };
}

/**
 * Composite tech rating (1–99) for one ticker's components, ranked against the
 * universe's stored components. Mirrors run()'s weighting (0.5 momentum, 0.3
 * trend, 0.2 RSI) — each component is percentiled against the distribution
 * (the value treated as inserted, so it needs no prior membership).
 */
export function techRatingFromComponents(
  c: TechComponents,
  universe: TechComponents[],
): number {
  const pct = (val: number, arr: number[]) => {
    const n = arr.length + 1;
    if (n === 1) return 100;
    const i = arr.filter((x) => x < val).length;
    return (i / (n - 1)) * 100;
  };
  const composite =
    0.5 * pct(c.momentum, universe.map((u) => u.momentum)) +
    0.3 * pct(c.trend, universe.map((u) => u.trend)) +
    0.2 * pct(c.rsi, universe.map((u) => u.rsi));
  return Math.min(99, Math.max(1, Math.round(composite)));
}

@Injectable()
export class TechRatingJob implements OnModuleInit {
  private readonly logger = new Logger(TechRatingJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["companies"],
      cronExpression: "15 4 * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  private async componentsFor(ticker: string) {
    const snap = await this.firebase.firestore
      .collection("ohlcv_bars")
      .where("ticker", "==", ticker)
      .orderBy("barDate", "desc")
      .limit(BARS_TO_READ)
      .get();
    const closes = snap.docs.map((d) => d.data().close).reverse();
    const c = computeTechComponents(closes);
    return c ? { ticker, ...c } : null;
  }

  async run() {
    try {
      const universe = await activeUniverse(this.firebase.firestore);
      if (universe.length === 0) {
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { count: 0, note: "no active tickers yet" };
      }
      const rows = [];
      let skipped = 0;
      for (const ticker of universe) {
        try {
          const c = await this.componentsFor(ticker);
          if (!c) {
            skipped++;
            continue;
          }
          rows.push(c);
        } catch (err) {
          this.logger.error(
            `Failed tech-rating components for ${ticker}: ${err.message}`,
          );
          skipped++;
        }
      }
      if (rows.length === 0) {
        this.logger.warn(
          `No tickers had enough ohlcv_bars for tech rating (${skipped}/${universe.length}) — has stock-history run?`,
        );
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { rated: 0, skipped };
      }
      const momP = percentiles(rows, (c) => c.momentum);
      const trendP = percentiles(rows, (c) => c.trend);
      const rsiP = percentiles(rows, (c) => c.rsi);
      const rating = new Map();
      for (const r of rows) {
        const composite =
          0.5 * (momP.get(r.ticker) ?? 0) +
          0.3 * (trendP.get(r.ticker) ?? 0) +
          0.2 * (rsiP.get(r.ticker) ?? 0);
        rating.set(r.ticker, Math.min(99, Math.max(1, Math.round(composite))));
      }
      const sectorByTicker = new Map();
      const companiesSnap = await this.firebase.firestore
        .collection("companies")
        .get();
      companiesSnap.docs.forEach((d) => {
        const s = d.data().sector;
        if (s) sectorByTicker.set(d.id, s);
      });
      const bySector = new Map();
      for (const r of rows) {
        const sec = sectorByTicker.get(r.ticker);
        if (!sec) continue;
        (bySector.get(sec) ?? bySector.set(sec, []).get(sec)).push(r.ticker);
      }
      const sectorRank = new Map();
      for (const [, tickers] of bySector) {
        const ordered = tickers.sort(
          (a, b) => (rating.get(b) ?? 0) - (rating.get(a) ?? 0),
        );
        ordered.forEach((t, i) =>
          sectorRank.set(t, { rank: i + 1, total: ordered.length }),
        );
      }
      const writes: PendingWrite[] = [];
      const col = this.firebase.firestore.collection("companies");
      for (const r of rows) {
        const sr = sectorRank.get(r.ticker);
        writes.push({
          ref: col.doc(r.ticker),
          data: {
            techRating: rating.get(r.ticker),
            sectorRank: sr?.rank ?? null,
            sectorRankTotal: sr?.total ?? null,
            // Raw components stored so the on-demand first-time company sync can
            // rank a brand-new ticker against this distribution (see
            // techRatingFromComponents / ondemand.service).
            techMomentum: r.momentum,
            techTrend: r.trend,
            techRsi: r.rsi,
            techRatingUpdatedAt: new Date().toISOString(),
          },
        });
      }
      await batchSetWithCreatedAt(this.firebase.firestore, writes);
      await this.meta.record(JOB_NAME, { ok: true, count: rows.length });
      return { rated: rows.length, skipped };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
