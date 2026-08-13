import { Injectable } from "@nestjs/common";
import { candidateTradingDays } from "../common/trading-days.util";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the `fear-greed` sync job + Firestore cache. Computes the
 * Fear & Greed composite on demand from Polygon bars (SPY/TLT/VIXY) plus today's
 * grouped-daily breadth. Formulas copied verbatim from `sync/fear-greed.job.ts`.
 *
 * History change vs. the old job: the per-day composite no longer joins the
 * `market_breadth` Firestore collection (that cache/job is being removed), so
 * historical days use the 3 price-based components only (momentum, safe-haven,
 * volatility). Today's value still adds live breadth. Historical breadth had no
 * cheap live source (it would need grouped-daily per past day), and the old job
 * already fell back to price-only for days market_breadth didn't cover.
 */
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

interface Series {
  spySer: { d: string; c: number }[];
  spy: number[];
  tlt: number[];
  vixy: number[];
}

@Injectable()
export class LiveMarketSentimentService {
  private readonly coalescer = new LiveCoalescer(5_000);

  constructor(private readonly polygon: PolygonService) {}

  private async loadSeries(ticker: string): Promise<{ d: string; c: number }[]> {
    const to = new Date();
    const from = new Date(to.getTime() - 220 * 24 * 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const bars = await this.polygon.getAggsRange(ticker, iso(from), iso(to));
    return bars
      .map((b) => ({ d: new Date(b.t).toISOString().slice(0, 10), c: b.c }))
      .filter((x) => Number.isFinite(x.c) && x.c > 0);
  }

  /** All three closing-price series, coalesced so both endpoints share one pull. */
  private series(): Promise<Series> {
    return this.coalescer.run("fg-series", async () => {
      const [spySer, tltSer, vixySer] = await Promise.all([
        this.loadSeries("SPY"),
        this.loadSeries("TLT"),
        this.loadSeries("VIXY"),
      ]);
      return {
        spySer,
        spy: spySer.map((x) => x.c),
        tlt: tltSer.map((x) => x.c),
        vixy: vixySer.map((x) => x.c),
      };
    });
  }

  /** 3 price-based components as of bar index `i` (inclusive). */
  private componentsAt(s: Series, i: number): Record<string, number> {
    const { spy, tlt, vixy } = s;
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

  async getFearGreed() {
    return this.coalescer.run("market-sentiment", async () => {
      const s = await this.series();
      const components = this.componentsAt(s, s.spy.length - 1);
      let asOfDate: string | null = null;
      const latest = await this.polygon.getLatestGroupedDaily(
        candidateTradingDays(new Date(), LOOKBACK_DAYS),
      );
      if (latest?.bars.length) {
        asOfDate = latest.date;
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
      if (vals.length === 0) return [];
      const value = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      return [
        {
          value,
          label: label(value),
          components: Object.fromEntries(
            Object.entries(components).map(([k, v]) => [k, Math.round(v)]),
          ),
          asOfDate,
          source: "polygon",
        },
      ];
    });
  }

  async getHistory() {
    return this.coalescer.run("market-sentiment-history", async () => {
      const s = await this.series();
      const hist: Record<string, unknown>[] = [];
      for (let i = 125; i < s.spySer.length; i++) {
        const date = s.spySer[i].d;
        const comp = this.componentsAt(s, i);
        const cv = Object.values(comp);
        if (cv.length === 0) continue;
        const v = Math.round(cv.reduce((a, b) => a + b, 0) / cv.length);
        hist.push({
          value: v,
          label: label(v),
          components: Object.fromEntries(
            Object.entries(comp).map(([k, val]) => [k, Math.round(val)]),
          ),
          asOfDate: date,
          source: "polygon",
        });
      }
      return hist;
    });
  }
}
