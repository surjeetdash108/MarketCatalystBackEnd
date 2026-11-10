import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

/**
 * GET /market-data/ipo-pipeline — recent SEC-EDGAR S-1/424B registration filings
 * (`ipo_pipeline`, written by the `edgar-ipo-pipeline` job). Backs the IPO
 * screen's "Upcoming pipeline" table.
 */
@Controller("market-data")
// Market data is the product. These read surfaces answered anonymous
// callers, returning full datasets — the policy lived only in a Firestore
// rules file that nothing enforces, because no client talks to Firestore.
@UseGuards(FirebaseAuthGuard)
export class IpoPipelineController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("ipo-pipeline")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async ipoPipeline() {
    await this.marketData.ensureFresh("edgar-ipo-pipeline");
    const { ipo_pipeline } = await this.cached.get(["ipo_pipeline"]);
    return ipo_pipeline;
  }
}
