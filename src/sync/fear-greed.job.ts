import { Injectable, Logger } from "@nestjs/common";
import { candidateTradingDays } from "../common/trading-days.util";
import { PolygonService } from "../vendors/polygon/polygon.service";

const LOOKBACK_DAYS = 5;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const sma = (v: number[], n: number) =>
  v.length < n ? null : v.slice(-n).reduce((a, b) => a + b, 0) / n;
const ret = (v: number[], n: number) =>
  v.length < n + 1 || v[v.length - 1 - n] <= 0
    ? null
    : (v[v.length - 1] - v[v.length - 1 - n]) / v[v.length - 1 - n];

function label(v: number): string {
  if (v < 25) return "Extreme Fear";
  if (v < 45) return "Fear";
  if (v <= 55) return "Neutral";
  if (v <= 75) return "Greed";
  return "Extreme Greed";
}

@Injectable()
export class FearGreedJob {
  private readonly logger = new Logger(FearGreedJob.name);

  constructor(private readonly polygon: PolygonService) {}

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
    spy: number[],
    tlt: number[],
    vixy: number[],
    i: number,
  ): Record<string, number> {
    const c: Record<string, number> = {};
    const spyMa = sma(spy.slice(0, i + 1), 125);
    if (spyMa) c.momentum = clamp(50 + (spy[i] / spyMa - 1) * 625);
    const spyR = ret(spy.slice(0, i + 1), 20);
    const tltR = ret(tlt.slice(0, i + 1), 20);
    if (spyR != null && tltR != null)
      c.safeHaven = clamp(50 + (spyR - tltR) * 500);
    const vixMa = sma(vixy.slice(0, i + 1), 50);
    if (vixMa) c.volatility = clamp(50 - (vixy[i] / vixMa - 1) * 250);
    return c;
  }

  private async priceSeries(): Promise<{
    spySer: { d: string; c: number }[];
    tltSer: { d: string; c: number }[];
    vixySer: { d: string; c: number }[];
  }> {
    const [spySer, tltSer, vixySer] = await Promise.all([
      this.series("SPY"),
      this.series("TLT"),
      this.series("VIXY"),
    ]);
    return { spySer, tltSer, vixySer };
  }

  /** Today's 4-component composite doc (`market_sentiment/fear_greed` shape). */
  private async computeLatest(ser: {
    spySer: { d: string; c: number }[];
    tltSer: { d: string; c: number }[];
    vixySer: { d: string; c: number }[];
  }): Promise<{ id: string; data: Record<string, unknown> }> {
    const spy = ser.spySer.map((x) => x.c);
    const tlt = ser.tltSer.map((x) => x.c);
    const vixy = ser.vixySer.map((x) => x.c);
    const components = this.componentsAt(spy, tlt, vixy, spy.length - 1);
    const latest = await this.polygon.getLatestGroupedDaily(
      candidateTradingDays(new Date(), LOOKBACK_DAYS),
    );
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
      throw new Error("No Fear & Greed components could be computed");
    }
    const value = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    return {
      id: "fear_greed",
      data: {
        value,
        label: label(value),
        components: Object.fromEntries(
          Object.entries(components).map(([k, v]) => [k, Math.round(v)]),
        ),
        asOfDate: latest?.date ?? null,
        source: "polygon",
        updatedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * The composite HISTORY (`market_sentiment_history/{date}` shape) from the 3
   * price-based components, computed live from Polygon per request.
   *
   * DEGRADED vs. the cache era: the per-day breadth input came from the
   * `market_breadth` collection (no single-call vendor source reproduces per-day
   * breadth history), which is no longer written. That component is dropped from
   * the historical composite to keep the request path Firestore-free; each day's
   * value is now the mean of momentum/safe-haven/volatility only. The LATEST
   * value (fetchLatestLive) still includes a live-computed breadth component.
   */
  private computeHistory(ser: {
    spySer: { d: string; c: number }[];
    tltSer: { d: string; c: number }[];
    vixySer: { d: string; c: number }[];
  }): { id: string; data: Record<string, unknown> }[] {
    const spy = ser.spySer.map((x) => x.c);
    const tlt = ser.tltSer.map((x) => x.c);
    const vixy = ser.vixySer.map((x) => x.c);
    const hist: { id: string; data: Record<string, unknown> }[] = [];
    // Start once the 125-day momentum window is available.
    for (let i = 125; i < ser.spySer.length; i++) {
      const date = ser.spySer[i].d;
      const comp = this.componentsAt(spy, tlt, vixy, i);
      const cv = Object.values(comp);
      if (cv.length === 0) continue;
      const v = Math.round(cv.reduce((a, b) => a + b, 0) / cv.length);
      hist.push({
        id: date,
        data: {
          value: v,
          label: label(v),
          components: Object.fromEntries(
            Object.entries(comp).map(([k, val]) => [k, Math.round(val)]),
          ),
          asOfDate: date,
          source: "polygon",
          updatedAt: new Date().toISOString(),
        },
      });
    }
    return hist;
  }

  /**
   * Live-direct: today's Fear & Greed composite (`market_sentiment` shape,
   * single `fear_greed` doc) computed fresh from Polygon per request WITHOUT
   * writing Firestore. Backs GET /market-data/market-sentiment.
   */
  async fetchLatestLive(): Promise<Record<string, unknown>[]> {
    const doc = await this.computeLatest(await this.priceSeries());
    return [{ id: doc.id, ...doc.data }];
  }

  /**
   * Live-direct: the composite Fear & Greed history (`market_sentiment_history`
   * shape). Price components come live from Polygon; the per-day breadth input
   * (formerly joined from `market_breadth`) is dropped — see computeHistory.
   * Backs GET /market-data/market-sentiment-history.
   */
  async fetchHistoryLive(): Promise<Record<string, unknown>[]> {
    const hist = this.computeHistory(await this.priceSeries());
    return hist.map((h) => ({ id: h.id, ...h.data }));
  }
}
