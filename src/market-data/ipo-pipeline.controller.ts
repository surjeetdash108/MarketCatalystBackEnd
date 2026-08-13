import { Controller, Get } from "@nestjs/common";
import { LiveIpoPipelineService } from "./live-ipo-pipeline.service";

/**
 * GET /market-data/ipo-pipeline — recent SEC-EDGAR S-1/424B registration filings
 * backing the IPO screen's "Upcoming pipeline" table. Served LIVE per request by
 * parsing EDGAR's quarterly `master.idx` (no Firestore cache, no sync job);
 * concurrent requests are coalesced in the service (10-min reuse — the index is
 * large and IPO registrations are daily-cadence).
 */
@Controller("market-data")
export class IpoPipelineController {
  constructor(private readonly liveIpoPipeline: LiveIpoPipelineService) {}

  @Get("ipo-pipeline")
  async ipoPipeline() {
    return this.liveIpoPipeline.getIpoPipeline();
  }
}
