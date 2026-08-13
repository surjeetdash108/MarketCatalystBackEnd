import { Controller, Get, Header } from "@nestjs/common";
import { EdgarIpoPipelineJob } from "../sync/edgar-ipo-pipeline.job";

/**
 * GET /market-data/ipo-pipeline — recent SEC-EDGAR S-1/424B registration
 * filings. Backs the IPO screen's "Upcoming pipeline" table. Live-direct:
 * fetched per request from SEC-EDGAR's full-index via the source job, no
 * Firestore cache.
 */
@Controller("market-data")
export class IpoPipelineController {
  constructor(private readonly job: EdgarIpoPipelineJob) {}

  @Get("ipo-pipeline")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async ipoPipeline() {
    return this.job.fetchLive();
  }
}
