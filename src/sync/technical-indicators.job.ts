import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { batchSetWithCreatedAt, type PendingWrite } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { TICKER_UNIVERSE } from '../common/ticker-universe';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'technical-indicators';
const BARS_TO_READ = 120;
const MIN_BARS = 40;
const RVOL_WINDOW = 20;

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function rsi(closes: number[], period = 14) {
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

function macd(closes: number[]) {
  if (closes.length < 35)
    return null;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const line = closes.map((_, i) => ema12[i] - ema26[i]);
  const signal = ema(line, 9);
  const i = closes.length - 1;
  return {
    macd: line[i],
    signal: signal[i],
    histogram: line[i] - signal[i],
  };
}

function rvol(volumes: number[], window = RVOL_WINDOW) {
  if (volumes.length < window + 1)
    return null;
  const latest = volumes[volumes.length - 1];
  const prior = volumes.slice(-window - 1, -1);
  const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
  return avg > 0 ? latest / avg : null;
}

@Injectable()
export class TechnicalIndicatorsJob implements OnModuleInit {
  private readonly logger = new Logger(TechnicalIndicatorsJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['companies'],
      cronExpression: '10 4 * * *',
      timeZone: 'America/New_York',
    });
  }

  @Cron('10 4 * * *', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  private async computeFor(ticker: string) {
    const snap = await this.firebase.firestore
      .collection('ohlcv_bars')
      .where('ticker', '==', ticker)
      .orderBy('barDate', 'desc')
      .limit(BARS_TO_READ)
      .get();
    if (snap.size < MIN_BARS)
      return null;
    const bars = snap.docs.map((d) => d.data()).reverse();
    const closes = bars.map((b) => b.close);
    const volumes = bars.map((b) => b.volume);
    const rsiVal = rsi(closes);
    const macdVal = macd(closes);
    if (rsiVal == null || macdVal == null)
      return null;
    return {
      rsi14: Math.round(rsiVal * 100) / 100,
      macd: Math.round(macdVal.macd * 10000) / 10000,
      macdSignal: Math.round(macdVal.signal * 10000) / 10000,
      macdHistogram: Math.round(macdVal.histogram * 10000) / 10000,
      rvol: (() => {
        const v = rvol(volumes);
        return v == null ? null : Math.round(v * 100) / 100;
      })(),
    };
  }

  async run() {
    try {
      const results = [];
      let skipped = 0;
      for (const ticker of TICKER_UNIVERSE) {
        try {
          const ind = await this.computeFor(ticker);
          if (!ind) {
            skipped++;
            continue;
          }
          results.push({
            ticker,
            data: { ...ind, technicalsUpdatedAt: new Date().toISOString() },
          });
        } catch (err) {
          this.logger.error(`Failed computing indicators for ${ticker}: ${err.message}`);
          skipped++;
        }
      }
      if (results.length === 0) {
        this.logger.warn(`No tickers had enough ohlcv_bars to compute indicators (${skipped}/${TICKER_UNIVERSE.length} skipped) — has stock-history.job.ts run yet?`);
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { computed: 0, skipped };
      }
      const writes: PendingWrite[] = [];
      const col = this.firebase.firestore.collection('companies');
      for (const r of results) {
        writes.push({ ref: col.doc(r.ticker), data: r.data });
      }
      await batchSetWithCreatedAt(this.firebase.firestore, writes);
      await this.meta.record(JOB_NAME, { ok: true, count: results.length });
      return { computed: results.length, skipped };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
