import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

/**
 * GET /market-data/recaps — backs the Recap screen's numeric fields
 * (indices/gainers/losers/sector leaders-laggards/internals). `recaps.job.ts`
 * writes `narrative: null` — the headline/story prose isn't produced by any
 * job yet, so the screen's hardcoded headline copy stays as-is.
 */
@Controller("market-data")
// Market data is the product. These read surfaces answered anonymous
// callers, returning full datasets — the policy lived only in a Firestore
// rules file that nothing enforces, because no client talks to Firestore.
@UseGuards(FirebaseAuthGuard)
export class RecapsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("recaps")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async recaps() {
    await this.marketData.ensureFresh("recaps");
    const { recaps } = await this.cached.get(["recaps"]);
    return recaps;
  }
}
