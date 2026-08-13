import { Controller, Get } from "@nestjs/common";
import { LiveMoversService } from "./live-movers.service";

/**
 * GET /market-data/movers — the Movers screen + Dashboard/shell "Movers"
 * widgets (`LiveMoverDoc` shape). Served LIVE per request: whole-market
 * grouped-daily diff + parallel name/sector/cap enrichment, coalesced for a few
 * seconds. No cache, no job. (The optional `?limit` the widget sends is ignored,
 * same as before — the UI slices; the coalescer shares one board across callers.)
 */
@Controller("market-data")
export class MarketMoversController {
  constructor(private readonly liveMovers: LiveMoversService) {}

  @Get("movers")
  async movers() {
    return this.liveMovers.getMovers();
  }
}
