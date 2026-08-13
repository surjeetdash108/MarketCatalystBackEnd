import { Controller, Get } from "@nestjs/common";
import { LiveDividendsService } from "./live-dividends.service";

/**
 * GET /market-data/dividends — upcoming dividend calendar with derived yield.
 * Served LIVE per request (Polygon dividends calendar + snapshot prices for the
 * yield). No cache, no job.
 */
@Controller("market-data")
export class DividendsController {
  constructor(private readonly liveDividends: LiveDividendsService) {}

  @Get("dividends")
  async dividends() {
    return this.liveDividends.getDividends();
  }
}
