import { Controller, Get, Header } from "@nestjs/common";
import { MacroEventsJob } from "../sync/macro-events.job";

/**
 * GET /market-data/macro-events — backs the Macro & VIX screen's live economic
 * calendar (the `MacroEventDoc` shape). Live-direct: fetched per request from
 * FRED via the source job, no Firestore cache.
 */
@Controller("market-data")
export class MacroEventsController {
  constructor(private readonly job: MacroEventsJob) {}

  @Get("macro-events")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async macroEvents() {
    return this.job.fetchLive();
  }
}
