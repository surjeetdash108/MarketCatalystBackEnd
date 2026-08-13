import { Controller, Get, Header } from "@nestjs/common";
import { IposJob } from "../sync/ipos.job";

/**
 * GET /market-data/ipos — backs the IPO Corner screen's live calendar (the
 * `IpoEventDoc` shape). Live-direct: fetched per request from the vendor via the
 * source job, no Firestore cache.
 */
@Controller("market-data")
export class IposController {
  constructor(private readonly job: IposJob) {}

  @Get("ipos")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async ipos() {
    return this.job.fetchLive();
  }
}
