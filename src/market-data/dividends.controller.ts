import { Controller, Get, Header } from "@nestjs/common";
import { DividendsJob } from "../sync/dividends.job";

/**
 * GET /market-data/dividends — backs the Macro & VIX screen's live dividend
 * calendar (the `DividendDoc` shape). Live-direct: fetched per request from the
 * vendor via the source job, no Firestore cache.
 */
@Controller("market-data")
export class DividendsController {
  constructor(private readonly job: DividendsJob) {}

  @Get("dividends")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async dividends() {
    return this.job.fetchLive();
  }
}
