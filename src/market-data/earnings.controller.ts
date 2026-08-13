import { Controller, Get, Header } from '@nestjs/common';
import { AlphaVantageService } from '../vendors/alphavantage/alphavantage.service';

/**
 * GET /market-data/earnings — backs the Earnings Hub screen's live calendar.
 * Calls Alpha Vantage's EARNINGS_CALENDAR directly on every request (no
 * Firestore cache, no sync job) — switched from FMP after repeatedly hitting
 * FMP's plan rate limit (429 "Limit Reach"). Alpha Vantage's calendar is
 * forward-looking and estimate-only: it has no market-wide actuals feed (only
 * a per-symbol EARNINGS endpoint, unusable here without pre-known tickers and
 * a request-per-ticker fan-out that would blow through Alpha Vantage's own
 * rate limit even faster), so `epsActual`/`revenueEstimate`/`revenueActual`/
 * `surprisePct` are always null here — FMP's calendar could populate past
 * actuals; this one can't. The frontend already falls back to the ticker
 * when companyName is missing and renders "—" for null EPS/revenue fields.
 */
@Controller('market-data')
export class EarningsController {
  constructor(private readonly alphaVantage: AlphaVantageService) {}

  @Get('earnings')
  @Header('Cache-Control', 'no-store')
  async earnings() {
    const rows = await this.alphaVantage.getEarningsCalendar('3month');
    return rows.map((r) => ({
      id: `${r.symbol}_${r.reportDate}`,
      ticker: r.symbol,
      companyName: r.name || null,
      date: r.reportDate,
      periodEnd: r.fiscalDateEnding || null,
      fiscalPeriod: null,
      fiscalYear: null,
      session: null,
      epsEstimate: r.estimate,
      epsActual: null,
      revenueEstimate: null,
      revenueActual: null,
      surprisePct: null,
      updatedAt: new Date().toISOString(),
    }));
  }
}
