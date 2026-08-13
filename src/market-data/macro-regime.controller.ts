import { Controller, Get } from "@nestjs/common";
import { LiveMacroRegimeService } from "./live-macro-regime.service";

/**
 * GET /market-data/macro-regime — the rules-based FRED-derived market-regime
 * read (curve, VIX, credit, trend, jobs). Served LIVE per request (no cache, no
 * job). Returns a single-element list to match the prior collection shape.
 */
@Controller("market-data")
export class MacroRegimeController {
  constructor(private readonly liveMacroRegime: LiveMacroRegimeService) {}

  @Get("macro-regime")
  async macroRegime() {
    return this.liveMacroRegime.getMacroRegime();
  }
}
