import { Controller, Get } from "@nestjs/common";
import { LiveMacroEventsService } from "./live-macro-events.service";

/**
 * GET /market-data/macro-events — the Macro & VIX economic calendar
 * (`MacroEventDoc` shape). Served LIVE from FRED per request (no cache, no job).
 */
@Controller("market-data")
export class MacroEventsController {
  constructor(private readonly liveMacroEvents: LiveMacroEventsService) {}

  @Get("macro-events")
  async macroEvents() {
    return this.liveMacroEvents.getMacroEvents();
  }
}
