import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { batchSetWithCreatedAt, type PendingWrite } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { TICKER_UNIVERSE } from '../common/ticker-universe';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'tech-rating';
const BARS_TO_READ = 130;
const MIN_BARS = 65;
const MOMENTUM_DAYS = 63;
const SMA_PERIOD = 50;

function sma(values: number[], n: number) {
  if (values.length < n)
    return null;
  const slice = values.slice(values.length - n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

function rsi14(closes: number[], period = 14) {
  if (closes.length < period + 1)
    return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0)
      gain += d;
    else
      loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0)
    return 100;
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
      collections: ['companies'],
      cronExpression: '15 4 * * *',
      timeZone: 'America/New_York',
    });
  }

  @Cron('15 4 * * *', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  private async componentsFor(ticker: string) {
    const snap = await this.firebase.firestore
      .collection('ohlcv_bars')
      .where('ticker', '==', ticker)
      .orderBy('barDate', 'desc')
      .limit(BARS_TO_READ)
      .get();
    if (snap.size < MIN_BARS)
      return null;
    const closes = snap.docs.map((d) => d.data().close).reverse();
    const price = closes[closes.length - 1];
    const past = closes[closes.length - 1 - MOMENTUM_DAYS];
    const ma50 = sma(closes, SMA_PERIOD);
    const rsiVal = rsi14(closes);
    if (past == null || past <= 0 || ma50 == null || ma50 <= 0 || rsiVal == null) {
      return null;
    }
    return {
      ticker,
      momentum: (price - past) / past,
      trend: price / ma50 - 1,
      rsi: rsiVal,
    };
  }

  async run() {
    try {
      const rows = [];
      let skipped = 0;
      for (const ticker of TICKER_UNIVERSE) {
        try {
          const c = await this.componentsFor(ticker);
          if (!c) {
            skipped++;
            continue;
          }
          rows.push(c);
        } catch (err) {
          this.logger.error(`Failed tech-rating components for ${ticker}: ${err.message}`);
          skipped++;
        }
      }
      if (rows.length === 0) {
        this.logger.warn(`No tickers had enough ohlcv_bars for tech rating (${skipped}/${TICKER_UNIVERSE.length}) — has stock-history run?`);
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { rated: 0, skipped };
      }
      const momP = percentiles(rows, (c) => c.momentum);
      const trendP = percentiles(rows, (c) => c.trend);
      const rsiP = percentiles(rows, (c) => c.rsi);
      const rating = new Map();
      for (const r of rows) {
        const composite = 0.5 * (momP.get(r.ticker) ?? 0) +
          0.3 * (trendP.get(r.ticker) ?? 0) +
          0.2 * (rsiP.get(r.ticker) ?? 0);
        rating.set(r.ticker, Math.min(99, Math.max(1, Math.round(composite))));
      }
      const sectorByTicker = new Map();
      const companiesSnap = await this.firebase.firestore
        .collection('companies')
        .get();
      companiesSnap.docs.forEach((d) => {
        const s = d.data().sector;
        if (s)
          sectorByTicker.set(d.id, s);
      });
      const bySector = new Map();
      for (const r of rows) {
        const sec = sectorByTicker.get(r.ticker);
        if (!sec)
          continue;
        (bySector.get(sec) ?? bySector.set(sec, []).get(sec)).push(r.ticker);
      }
      const sectorRank = new Map();
      for (const [, tickers] of bySector) {
        const ordered = tickers.sort((a, b) => (rating.get(b) ?? 0) - (rating.get(a) ?? 0));
        ordered.forEach((t, i) => sectorRank.set(t, { rank: i + 1, total: ordered.length }));
      }
      const writes: PendingWrite[] = [];
      const col = this.firebase.firestore.collection('companies');
      for (const r of rows) {
        const sr = sectorRank.get(r.ticker);
        writes.push({
          ref: col.doc(r.ticker),
          data: {
            techRating: rating.get(r.ticker),
            sectorRank: sr?.rank ?? null,
            sectorRankTotal: sr?.total ?? null,
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
