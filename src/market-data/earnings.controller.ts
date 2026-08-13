import { Controller, Get, Header } from "@nestjs/common";
import { FmpService } from "../vendors/fmp/fmp.service";

/**
 * GET /market-data/earnings — backs the Earnings Hub screen's live calendar
 * (the `LiveEarningsDoc` shape — see MarketCatalystUI/app/iq/types/earnings.ts).
 * Fetches live, directly from FMP's earnings calendar per request over a
 * today−7d … today+14d window. No Firestore cache, no sync job.
 */
@Controller("market-data")
export class EarningsController {
  constructor(private readonly fmp: FmpService) {}

  @Get("earnings")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async earnings() {
    const now = new Date();
    const isoDate = (d: Date) => d.toISOString().slice(0, 10);
    const addDays = (d: Date, n: number) => {
      const out = new Date(d);
      out.setUTCDate(out.getUTCDate() + n);
      return out;
    };

    const from = isoDate(addDays(now, -7));
    const to = isoDate(addDays(now, 14));

    const rows = await this.fmp.getEarningsCalendar(from, to);

    return rows.map((r) => ({
      id: `${r.symbol}_${r.date}`,
      ticker: r.symbol,
      // FMP's earnings calendar carries no company name; the UI falls back to
      // the ticker.
      companyName: null as string | null,
      date: r.date,
      // FMP's earnings calendar carries no reporting session.
      session: null as "BMO" | "AMC" | null,
      epsEstimate: r.epsEstimated,
      epsActual: r.epsActual,
      revenueEstimate: r.revenueEstimated,
      revenueActual: r.revenueActual,
    }));
  }
}
