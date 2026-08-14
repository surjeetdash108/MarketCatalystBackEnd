import { Controller, Get, Header } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";

/**
 * GET /market-data/filings-wire — recent SEC-EDGAR 8-K filings as a filings
 * "newswire" feed (`filings_wire`, written by the `edgar-8k` job). Backs the
 * commentary/news filings-wire card.
 */
@Controller("market-data")
export class FilingsWireController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("filings-wire")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async filingsWire() {
    await this.marketData.ensureFresh("edgar-8k");
    const { filings_wire } = await this.cached.get(["filings_wire"]);
    return filings_wire;
  }
}
