import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

/**
 * GET /market-data/earnings — backs the Earnings Hub screen's live calendar
 * (the `LiveEarningsDoc` shape). Triggers the `earnings` sync job on demand
 * when stale/empty per decision #3a.
 */
@Controller("market-data")
// Market data is the product. These read surfaces answered anonymous
// callers, returning full datasets — the policy lived only in a Firestore
// rules file that nothing enforces, because no client talks to Firestore.
@UseGuards(FirebaseAuthGuard)
export class EarningsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("earnings")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async earnings() {
    await this.marketData.ensureFresh("earnings");
    const { earnings_events } = await this.cached.get(["earnings_events"]);
    return earnings_events;
  }
}
