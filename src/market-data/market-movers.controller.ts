import { Controller, Get, Header } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";

/**
 * GET /market-data/movers — backs the Movers screen and the Dashboard/shell
 * "Movers" widgets. Shapes straight off `market_movers` (already the
 * `LiveMoverDoc` shape the UI expects — see cached-collections.service.ts's
 * `{ id: d.id, ...d.data() }` mapping), triggering the `market-movers` sync
 * job on demand when stale/empty per decision #3a — no cron populates this.
 */
@Controller("market-data")
export class MarketMoversController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("movers")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async movers() {
    await this.marketData.ensureFresh("market-movers");
    const { market_movers } = await this.cached.get(["market_movers"]);
    return market_movers;
  }
}
