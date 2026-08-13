import { Inject, Injectable } from "@nestjs/common";
import { DIVIDENDS_ADAPTER, type DividendsAdapter } from "../adapters/types";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the `dividends` sync job + Firestore cache. Fetches the
 * upcoming dividend calendar (today..+30d) and derives the annualized yield.
 *
 * Yield-price source change: the job read the last close off the cached
 * `companies` Firestore doc. Since that cache is being removed, prices are
 * pulled live via Polygon's universal snapshot (batched ≤250/call). Same yield
 * formula (amount × payments-per-year ÷ price). Doc shape preserved. Coalesced.
 */
const LOOKAHEAD_DAYS = 30;
const PAYMENTS_PER_YEAR: Record<string, number> = {
  Annual: 1,
  "Semi-Annual": 2,
  Quarterly: 4,
  Monthly: 12,
};

function dividendDocId(e: { symbol: string; date: string | null; vendorEventId?: string | null }): string {
  const base = e.date ? `${e.symbol}_${e.date}` : e.symbol;
  return e.vendorEventId ? `${base}_${e.vendorEventId.slice(0, 12)}` : base;
}

@Injectable()
export class LiveDividendsService {
  private readonly coalescer = new LiveCoalescer(5_000);

  constructor(
    @Inject(DIVIDENDS_ADAPTER) private readonly dividends: DividendsAdapter,
    private readonly polygon: PolygonService,
  ) {}

  async getDividends() {
    return this.coalescer.run("dividends", async () => {
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const now = new Date();
      const to = new Date(now); to.setUTCDate(to.getUTCDate() + LOOKAHEAD_DAYS);
      const result = await this.dividends.fetchDividends(iso(now), iso(to));
      const events = result.data;

      // Live prices for yield, via universal snapshot (≤250 tickers per call).
      const symbols = [...new Set(events.map((e) => e.symbol).filter(Boolean))];
      const priceByTicker = new Map<string, number>();
      for (let i = 0; i < symbols.length; i += 250) {
        const snap = await this.polygon
          .getUniversalSnapshot(symbols.slice(i, i + 250))
          .catch(() => []);
        for (const s of snap) {
          const px = s.price ?? s.previousClose;
          if (typeof px === "number" && px > 0) priceByTicker.set(s.ticker, px);
        }
      }

      const annualizedYield = (e: (typeof events)[number]): number | null => {
        const price = priceByTicker.get(e.symbol);
        const perYear = e.frequency ? PAYMENTS_PER_YEAR[e.frequency] : undefined;
        if (!price || !perYear || !e.dividend) return null;
        return Math.round(((e.dividend * perYear) / price) * 10000) / 100;
      };

      return events.map((e) => ({
        id: dividendDocId(e),
        ticker: e.symbol,
        exDividendDate: e.date,
        recordDate: e.recordDate,
        paymentDate: e.paymentDate,
        declarationDate: e.declarationDate,
        dividendAmount: e.dividend,
        yieldPct: e.yield ?? annualizedYield(e),
        yieldIsDerived: e.yield == null,
        frequency: e.frequency,
        source: result.source,
      }));
    });
  }
}
