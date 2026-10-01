import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

/**
 * GET /market-data/analyst-actions — backs the Analyst Actions screen's live
 * consensus card (the `AnalystConsensusDoc` shape). Triggers the
 * `analyst-actions` sync job on demand when stale/empty per decision #3a.
 */
@Controller("market-data")
// Market data is the product. These read surfaces answered anonymous
// callers, returning full datasets — the policy lived only in a Firestore
// rules file that nothing enforces, because no client talks to Firestore.
@UseGuards(FirebaseAuthGuard)
export class AnalystActionsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("analyst-actions")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async analystActions() {
    await this.marketData.ensureFresh("analyst-actions");
    const { analyst_actions } = await this.cached.get(["analyst_actions"]);
    return analyst_actions;
  }
}
