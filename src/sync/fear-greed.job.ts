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
      collections: ['market_sentiment', 'market_sentiment_history'],
      cronExpression: '15 18 * * 1-5',
      timeZone: 'America/New_York',
    });
  }

  @Cron('15 18 * * 1-5', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  /** Daily closes WITH their trading date, so the history backfill can align them. */
  private async series(ticker: string): Promise<{ d: string; c: number }[]> {
    const to = new Date();
    const from = new Date(to.getTime() - 220 * 24 * 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const bars = await this.polygon.getAggsRange(ticker, iso(from), iso(to));
    // `t` is epoch-ms at the bar's start; the UTC date is the ET trading date for
    // a daily bar. Filter out any malformed rows so index math stays sound.
    return bars
      .map((b) => ({ d: new Date(b.t).toISOString().slice(0, 10), c: b.c }))
      .filter((x) => Number.isFinite(x.c) && x.c > 0);
  }

  /**
   * The three price-based components as of bar index `i` (inclusive), from the
   * trailing window — the same formulas the latest-value path uses, evaluated at
   * a historical point. Returns only the components with enough history at `i`.
   */
  private componentsAt(
    spy: number[], tlt: number[], vixy: number[], i: number,
  ): Record<string, number> {
    const c: Record<string, number> = {};
    const spyMa = sma(spy.slice(0, i + 1), 125);
    if (spyMa) c.momentum = clamp(50 + (spy[i] / spyMa - 1) * 625);
    const spyR = ret(spy.slice(0, i + 1), 20);
    const tltR = ret(tlt.slice(0, i + 1), 20);
    if (spyR != null && tltR != null) c.safeHaven = clamp(50 + (spyR - tltR) * 500);
    const vixMa = sma(vixy.slice(0, i + 1), 50);
    if (vixMa) c.volatility = clamp(50 - (vixy[i] / vixMa - 1) * 250);
    return c;
  }

  async run() {
    try {
      const [spySer, tltSer, vixySer] = await Promise.all([
        this.series('SPY'),
        this.series('TLT'),
        this.series('VIXY'),
      ]);
      const spy = spySer.map((x) => x.c);
      const tlt = tltSer.map((x) => x.c);
      const vixy = vixySer.map((x) => x.c);

      // Today's value — unchanged 4-component composite.
      const components = this.componentsAt(spy, tlt, vixy, spy.length - 1);
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

      // ── R26: backfill the real composite HISTORY ──────────────────────────
      // The dashboard's F&G history line was reading market_breadth.breadthSentiment
      // (a breadth-ONLY proxy) because no historical composite existed. Compute the
      // 3 price-based components as of each past trading day and join the stored
      // per-day breadth (market_breadth.breadthPct) — the same four inputs as the
      // live value — and write market_sentiment_history/{date}.
      const breadthByDate = new Map<string, number>();
      const bsnap = await this.firebase.firestore.collection('market_breadth').get();
      for (const d of bsnap.docs) {
        const b = d.data();
        if (typeof b.breadthPct === 'number') breadthByDate.set(d.id, clamp(b.breadthPct * 100));
      }
      const hist: { id: string; data: Record<string, unknown> }[] = [];
      // Start once the 125-day momentum window is available.
      for (let i = 125; i < spySer.length; i++) {
        const date = spySer[i].d;
        const comp = this.componentsAt(spy, tlt, vixy, i);
        const br = breadthByDate.get(date);
        if (br != null) comp.breadth = br;
        const cv = Object.values(comp);
        if (cv.length === 0) continue;
        const v = Math.round(cv.reduce((a, b) => a + b, 0) / cv.length);
        hist.push({
          id: date,
          data: {
            value: v,
            label: label(v),
            components: Object.fromEntries(Object.entries(comp).map(([k, val]) => [k, Math.round(val)])),
            asOfDate: date,
            source: 'polygon',
            updatedAt: new Date().toISOString(),
          },
        });
      }
      // Chunked batch write (Firestore caps at 500 ops/batch).
      const col = this.firebase.firestore.collection('market_sentiment_history');
      for (let i = 0; i < hist.length; i += 400) {
        const batch = this.firebase.firestore.batch();
        for (const h of hist.slice(i, i + 400)) batch.set(col.doc(h.id), h.data, { merge: true });
        await batch.commit();
      }

      await this.meta.record(JOB_NAME, { ok: true, count: 1 });
      this.logger.log(`fear-greed: value ${value}; backfilled ${hist.length} history day(s)`);
      return { value, label: label(value), components, historyDays: hist.length };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
