import { Controller, Get, Header } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";

/**
 * GET /market-data/macro-events — backs the Macro & VIX screen's live
 * economic calendar (the `MacroEventDoc` shape). Triggers the `macro-events`
 * sync job on demand when stale/empty per decision #3a.
 */
@Controller("market-data")
export class MacroEventsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("macro-events")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async macroEvents() {
    await this.marketData.ensureFresh("macro-events");
    const { macro_events } = await this.cached.get(["macro_events"]);
    return macro_events;
  }
}
