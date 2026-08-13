import { Controller, Get, Header, Inject } from '@nestjs/common';
import { DIVIDENDS_ADAPTER, type DividendsAdapter } from '../adapters/types';

const LOOKAHEAD_DAYS = 30;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Stable, unique document ID for one dividend event — see dividends.job.ts
 * for why symbol+exDate alone isn't always enough (regular + special
 * dividend on the same ex-date).
 */
function dividendDocId(e: { symbol: string; date: string | null; vendorEventId?: string | null }): string {
  const base = e.date ? `${e.symbol}_${e.date}` : e.symbol;
  return e.vendorEventId ? `${base}_${e.vendorEventId.slice(0, 12)}` : base;
}

/**
 * GET /market-data/dividends — backs the Macro & VIX screen's live dividend
 * calendar. Calls the dividends adapter directly on every request (no
 * Firestore cache, no sync job) — mirrors dividends.job.ts's fetch, minus
 * persistence. Unlike the job, this does NOT derive a yield from a live
 * price lookup: the 30-day window spans ~2000 distinct tickers, and a
 * per-symbol live quote call for all of them is too slow for a request-time
 * endpoint. `yieldPct` is Polygon's own field, which is always null.
 */
@Controller('market-data')
export class DividendsController {
  constructor(@Inject(DIVIDENDS_ADAPTER) private readonly dividendsAdapter: DividendsAdapter) {}

  @Get('dividends')
  @Header('Cache-Control', 'no-store')
  async dividends() {
    const from = isoDate(new Date());
    const to = new Date();
    to.setUTCDate(to.getUTCDate() + LOOKAHEAD_DAYS);
    const result = await this.dividendsAdapter.fetchDividends(from, isoDate(to));

    return result.data.map((e) => ({
      id: dividendDocId(e),
      ticker: e.symbol,
      exDividendDate: e.date,
      recordDate: e.recordDate,
      paymentDate: e.paymentDate,
      declarationDate: e.declarationDate,
      dividendAmount: e.dividend,
      yieldPct: e.yield,
      yieldIsDerived: false,
      frequency: e.frequency,
      source: result.source,
      warnings: result.warnings,
      updatedAt: new Date().toISOString(),
    }));
  }
}
