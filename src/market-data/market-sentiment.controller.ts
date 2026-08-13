import { Controller, Get, Header } from '@nestjs/common';
import { candidateTradingDays } from '../common/trading-days.util';
import { PolygonService } from '../vendors/polygon/polygon.service';

const LOOKBACK_DAYS = 5;
const HISTORY_WARMUP = 125;
const HISTORY_CONCURRENCY = 15;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const sma = (v: number[], n: number) => (v.length < n ? null : v.slice(-n).reduce((a, b) => a + b, 0) / n);
const ret = (v: number[], n: number) =>
  v.length < n + 1 || v[v.length - 1 - n] <= 0 ? null : (v[v.length - 1] - v[v.length - 1 - n]) / v[v.length - 1 - n];

function label(v: number): string {
  if (v < 25) return 'Extreme Fear';
  if (v < 45) return 'Fear';
  if (v <= 55) return 'Neutral';
  if (v <= 75) return 'Greed';
  return 'Extreme Greed';
}

/**
 * GET /market-data/market-sentiment — backs the Dashboard's Fear & Greed
 * card. Calls Polygon directly on every request (no Firestore cache, no
 * sync job) — mirrors fear-greed.job.ts's "today's value" path, minus
 * persistence.
 *
 * GET /market-data/market-sentiment-history — the same composite, per past
 * trading day. The 3 price-based components are pure re-derived math over
 * the same 220-day series (no accumulation needed); breadth per historical
 * day calls Polygon's whole-market grouped-daily endpoint live, fanned out
 * with a concurrency cap (Polygon isn't rate-limited on this key — see
 * companies.controller.ts for the same reasoning).
 */
@Controller('market-data')
export class MarketSentimentController {
  constructor(private readonly polygon: PolygonService) {}

  /** Daily closes WITH their trading date, so history math can align them. */
  private async series(ticker: string): Promise<{ d: string; c: number }[]> {
    const to = new Date();
    const from = new Date(to.getTime() - 220 * 24 * 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const bars = await this.polygon.getAggsRange(ticker, iso(from), iso(to));
    return bars
      .map((b) => ({ d: new Date(b.t).toISOString().slice(0, 10), c: b.c }))
      .filter((x) => Number.isFinite(x.c) && x.c > 0);
  }

  private componentsAt(spy: number[], tlt: number[], vixy: number[], i: number): Record<string, number> {
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

  @Get('market-sentiment')
  @Header('Cache-Control', 'no-store')
  async marketSentiment() {
    const [spySer, tltSer, vixySer] = await Promise.all([
      this.series('SPY'),
      this.series('TLT'),
      this.series('VIXY'),
    ]);
    const spy = spySer.map((x) => x.c);
    const tlt = tltSer.map((x) => x.c);
    const vixy = vixySer.map((x) => x.c);

    const components = this.componentsAt(spy, tlt, vixy, spy.length - 1);
    const latest = await this.polygon.getLatestGroupedDaily(candidateTradingDays(new Date(), LOOKBACK_DAYS));
    if (latest && latest.bars.length) {
      let up = 0;
      let total = 0;
      for (const b of latest.bars) {
        if (b.o > 0) {
          total++;
          if (b.c > b.o) up++;
        }
      }
      if (total > 0) components.breadth = clamp((up / total) * 100);
    }
    const vals = Object.values(components);
    if (vals.length === 0) {
      throw new Error('No Fear & Greed components could be computed');
    }
    const value = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);

    return [
      {
        id: 'fear_greed',
        value,
        label: label(value),
        components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, Math.round(v)])),
        asOfDate: latest?.date ?? null,
        source: 'polygon',
        updatedAt: new Date().toISOString(),
      },
    ];
  }

  @Get('market-sentiment-history')
  @Header('Cache-Control', 'no-store')
  async marketSentimentHistory() {
    const [spySer, tltSer, vixySer] = await Promise.all([
      this.series('SPY'),
      this.series('TLT'),
      this.series('VIXY'),
    ]);
    const spy = spySer.map((x) => x.c);
    const tlt = tltSer.map((x) => x.c);
    const vixy = vixySer.map((x) => x.c);

    const indices = [];
    for (let i = HISTORY_WARMUP; i < spySer.length; i++) indices.push(i);

    const breadthByIndex = new Map<number, number>();
    for (let i = 0; i < indices.length; i += HISTORY_CONCURRENCY) {
      const chunk = indices.slice(i, i + HISTORY_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (idx) => {
          try {
            const bars = await this.polygon.getGroupedDaily(spySer[idx].d);
            let up = 0;
            let total = 0;
            for (const b of bars) {
              if (b.o > 0) {
                total++;
                if (b.c > b.o) up++;
              }
            }
            return total > 0 ? clamp((up / total) * 100) : null;
          } catch {
            return null;
          }
        }),
      );
      chunk.forEach((idx, j) => {
        const breadth = results[j];
        if (breadth != null) breadthByIndex.set(idx, breadth);
      });
    }

    const docs = [];
    for (const i of indices) {
      const date = spySer[i].d;
      const comp = this.componentsAt(spy, tlt, vixy, i);
      const breadth = breadthByIndex.get(i);
      if (breadth != null) comp.breadth = breadth;
      const vals = Object.values(comp);
      if (vals.length === 0) continue;
      const value = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      docs.push({
        id: date,
        value,
        label: label(value),
        components: Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, Math.round(v)])),
        asOfDate: date,
        source: 'polygon',
        updatedAt: new Date().toISOString(),
      });
    }
    return docs;
  }
}
