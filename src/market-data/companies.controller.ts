import { Controller, Get, Header } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";

/**
 * GET /market-data/companies — the bulk `companies` collection (per-ticker
 * price/pctChange/marketCap/rvol), shared by Movers (rvol enrichment),
 * Heatmap (tile price/marketCap) and, later, Dashboard. Triggers the
 * `companies` sync job on demand when stale/empty per decision #3a.
 */
@Controller("market-data")
export class CompaniesController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("companies")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async companies() {
    await this.marketData.ensureFresh("companies");
    const { companies } = await this.cached.get(["companies"]);
    return companies;
  }
}
