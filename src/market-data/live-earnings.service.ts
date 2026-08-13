import { Injectable } from "@nestjs/common";
import { FmpService } from "../vendors/fmp/fmp.service";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the `earnings` sync job + Firestore cache. Switches the
 * source from Polygon's past-only `getFinancialsByFilingDate` (actuals only, no
 * estimates, SEC-filing-date) to FMP's `earnings-calendar` — ONE call that
 * returns past AND future earnings with EPS/revenue estimates and the true
 * report date. This finally makes the Earnings Hub's Tomorrow / Next Week /
 * upcoming tabs work and adds beat/miss.
 *
 * Window: ±30 days around today (covers the hub's Last Week … Next Week / Month
 * tabs). Mapped to the `LiveEarningsDoc` shape the UI reads. Coalesced.
 */
const WINDOW_DAYS = 30;

@Injectable()
export class LiveEarningsService {
  private readonly coalescer = new LiveCoalescer(5_000);

  constructor(private readonly fmp: FmpService) {}

  async getEarnings() {
    return this.coalescer.run("earnings", async () => {
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const now = Date.now();
      const from = iso(new Date(now - WINDOW_DAYS * 86_400_000));
      const to = iso(new Date(now + WINDOW_DAYS * 86_400_000));
      const rows = await this.fmp.getEarningsCalendar(from, to);
      return rows.map((r) => ({
        id: `${r.symbol}_${r.date}`,
        ticker: r.symbol,
        companyName: null,
        date: r.date,
        session: null,
        epsEstimate: r.epsEstimated,
        epsActual: r.epsActual,
        revenueEstimate: r.revenueEstimated,
        revenueActual: r.revenueActual,
      }));
    });
  }
}
