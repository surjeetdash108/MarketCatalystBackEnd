import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { SyncMetaService } from '../common/sync-meta.service';
import { candidateTradingDays } from '../common/trading-days.util';
import { PolygonService } from '../vendors/polygon/polygon.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'fear-greed';
const LOOKBACK_DAYS = 5;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const sma = (v: number[], n: number) => v.length < n ? null : v.slice(-n).reduce((a, b) => a + b, 0) / n;
const ret = (v: number[], n: number) => v.length < n + 1 || v[v.length - 1 - n] <= 0
  ? null
  : (v[v.length - 1] - v[v.length - 1 - n]) / v[v.length - 1 - n];

function label(v: number): string {
  if (v < 25)
    return 'Extreme Fear';
  if (v < 45)
    return 'Fear';
  if (v <= 55)
    return 'Neutral';
  if (v <= 75)
    return 'Greed';
  return 'Extreme Greed';
}

@Injectable()
export class FearGreedJob implements OnModuleInit {
  private readonly logger = new Logger(FearGreedJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['market_sentiment'],
      cronExpression: '15 18 * * 1-5',
      timeZone: 'America/New_York',
    });
  }

  @Cron('15 18 * * 1-5', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  private async closes(ticker: string) {
    const to = new Date();
    const from = new Date(to.getTime() - 220 * 24 * 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const bars = await this.polygon.getAggsRange(ticker, iso(from), iso(to));
    return bars.map((b) => b.c);
  }

  async run() {
    try {
      const [spy, tlt, vixy] = await Promise.all([
        this.closes('SPY'),
        this.closes('TLT'),
        this.closes('VIXY'),
      ]);
      const components: Record<string, number> = {};
      const spyMa = sma(spy, 125);
      if (spyMa && spy.length) {
        components.momentum = clamp(50 + (spy[spy.length - 1] / spyMa - 1) * 625);
      }
      const spyR = ret(spy, 20);
      const tltR = ret(tlt, 20);
      if (spyR != null && tltR != null) {
        components.safeHaven = clamp(50 + (spyR - tltR) * 500);
      }
      const vixMa = sma(vixy, 50);
      if (vixMa && vixy.length) {
        components.volatility = clamp(50 - (vixy[vixy.length - 1] / vixMa - 1) * 250);
      }
      const latest = await this.polygon.getLatestGroupedDaily(candidateTradingDays(new Date(), LOOKBACK_DAYS));
      if (latest && latest.bars.length) {
        let up = 0;
        let total = 0;
        for (const b of latest.bars) {
          if (b.o > 0) {
            total++;
            if (b.c > b.o)
              up++;
          }
        }
        if (total > 0)
          components.breadth = clamp((up / total) * 100);
      }
      const vals = Object.values(components);
      if (vals.length === 0) {
        throw new Error('No Fear & Greed components could be computed');
      }
      const value = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      await this.firebase.firestore
        .collection('market_sentiment')
        .doc('fear_greed')
        .set({
          value,
          label: label(value),
          components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, Math.round(v)])),
          asOfDate: latest?.date ?? null,
          source: 'polygon',
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      await this.meta.record(JOB_NAME, { ok: true, count: 1 });
      return { value, label: label(value), components };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
