import { Controller, Get, Header } from '@nestjs/common';
import { FmpService } from '../vendors/fmp/fmp.service';

// This FMP plan tier 402s ("Special Endpoint") once `from` is more than 30
// days in the past — verified empirically (31 days back fails, 30 does not).
// Separately (and more surprisingly): a single call whose range STRADDLES
// today silently drops everything within a few days of "now" — verified by
// comparing from=-30/to=+90 (misses the last ~30 days entirely) against two
// split calls, past-only and future-only, which both come back complete with
// real epsActual. So this makes two calls instead of one and merges them.
const LOOKBACK_DAYS = 30;
const LOOKAHEAD_DAYS = 90;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/**
 * GET /market-data/earnings — backs the Earnings Hub screen's live calendar.
 * Calls FMP's earnings-calendar directly on every request (no Firestore
 * cache, no sync job) — a market-wide call covering past (actual+estimate),
 * today, and future (estimate only) in one shot, with `date` being the true
 * report date rather than an SEC filing date. Polygon has no
 * earnings-calendar/estimates product at all, which is why this endpoint
 * used to be actuals-only; FMP's key was already provisioned but unused.
 * FMP's calendar has no company name or BMO/AMC session field, so those stay
 * null — the frontend already falls back to the ticker when companyName is
 * missing. The past window is 30 days (not the old Polygon-era 180) because
 * this FMP plan tier 402s on an older `from` — see LOOKBACK_DAYS.
 */
@Controller('market-data')
export class EarningsController {
  constructor(private readonly fmp: FmpService) {}

  @Get('earnings')
  @Header('Cache-Control', 'no-store')
  async earnings() {
    const now = new Date();
    const [past, future] = await Promise.all([
      this.fmp.getEarningsCalendar(isoDate(addDays(now, -LOOKBACK_DAYS)), isoDate(now)),
      this.fmp.getEarningsCalendar(isoDate(addDays(now, 1)), isoDate(addDays(now, LOOKAHEAD_DAYS))),
    ]);
    return [...past, ...future].map((r) => ({
      id: `${r.symbol}_${r.date}`,
      ticker: r.symbol,
      companyName: null,
      date: r.date,
      periodEnd: null,
      fiscalPeriod: null,
      fiscalYear: null,
      session: null,
      epsEstimate: r.epsEstimated,
      epsActual: r.epsActual,
      revenueEstimate: r.revenueEstimated,
      revenueActual: r.revenueActual,
      surprisePct:
        r.epsActual != null && r.epsEstimated
          ? Math.round(((r.epsActual - r.epsEstimated) / Math.abs(r.epsEstimated)) * 10000) / 100
          : null,
      updatedAt: new Date().toISOString(),
    }));
  }
}
