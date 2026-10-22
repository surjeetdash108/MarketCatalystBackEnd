import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

/**
 * GET /market-data/sectors — backs the Market Heatmap screen's per-sector
 * `pctChange` (the `SectorApiDoc` shape). Triggers the `sectors` sync job on
 * demand when stale/empty per decision #3a.
 */
/** How old the sector rollup may be before a request rebuilds it. */
const SECTORS_STALE_MS = 10 * 60_000;

@Controller("market-data")
// Market data is the product. These read surfaces answered anonymous
// callers, returning full datasets — the policy lived only in a Firestore
// rules file that nothing enforces, because no client talks to Firestore.
@UseGuards(FirebaseAuthGuard)
export class SectorsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("sectors")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async sectors() {
    // Sector moves roll up companies.pctChange, which company-quotes refreshes
    // every 5 minutes; the default 20h window served the prior session's
    // sector moves all day. Rebuild when the rollup is over 10 minutes old.
    await this.marketData.ensureFresh("sectors", SECTORS_STALE_MS);
    const { sectors } = await this.cached.get(["sectors"]);
    return sectors;
  }
}
