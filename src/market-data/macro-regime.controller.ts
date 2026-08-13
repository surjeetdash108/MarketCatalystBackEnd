import { Controller, Get, Header } from "@nestjs/common";
import { MacroRegimeJob } from "../sync/macro-regime.job";

/**
 * GET /market-data/macro-regime — the rules-based FRED-derived market regime
 * label. Backs the commentary "General perspective" / macro regime read.
 * Live-direct: computed per request from FRED via the source job, no Firestore
 * cache.
 */
@Controller("market-data")
export class MacroRegimeController {
  constructor(private readonly job: MacroRegimeJob) {}

  @Get("macro-regime")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async macroRegime() {
    return this.job.fetchLive();
  }
}
