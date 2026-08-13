import { Controller, Get, Header } from '@nestjs/common';
import { PolygonService } from '../vendors/polygon/polygon.service';

const LOOKBACK_DAYS = 180;

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
 * Calls Polygon directly on every request (no Firestore cache, no sync job)
 * — mirrors earnings.job.ts's fetch, minus persistence. Polygon has no
 * earnings-calendar or estimate feed, so this is built from reported SEC
 * financials keyed on filing_date — past-only, actuals only.
 */
@Controller('market-data')
export class EarningsController {
  constructor(private readonly polygon: PolygonService) {}

  @Get('earnings')
  @Header('Cache-Control', 'no-store')
  async earnings() {
    const to = isoDate(new Date());
    const from = isoDate(addDays(new Date(), -LOOKBACK_DAYS));
    const rows = await this.polygon.getFinancialsByFilingDate(from, to);
    return rows
      .filter((r) => r.filingDate)
      .map((r) => ({
        id: `${r.ticker}_${r.filingDate}`,
        ticker: r.ticker,
        companyName: r.companyName,
        date: r.filingDate,
        periodEnd: r.periodEnd,
        fiscalPeriod: r.fiscalPeriod,
        fiscalYear: r.fiscalYear,
        session: null,
        epsEstimate: null,
        epsActual: r.epsActual,
        revenueEstimate: null,
        revenueActual: r.revenueActual,
        updatedAt: new Date().toISOString(),
      }));
  }
}
