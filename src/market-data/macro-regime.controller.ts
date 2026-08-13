import { Controller, Get, Header } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";

/**
 * GET /market-data/macro-regime — the rules-based FRED-derived market regime
 * label (`macro_regime/current`, written by the `macro-regime` job). Backs the
 * commentary "General perspective" / macro regime read.
 */
@Controller("market-data")
export class MacroRegimeController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("macro-regime")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async macroRegime() {
    await this.marketData.ensureFresh("macro-regime");
    const { macro_regime } = await this.cached.get(["macro_regime"]);
    return macro_regime;
  }
}
