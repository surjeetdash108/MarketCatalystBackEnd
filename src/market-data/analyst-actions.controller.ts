import { Controller, Get, Header } from "@nestjs/common";
import { AnalystActionsJob } from "../sync/analyst-actions.job";

/**
 * GET /market-data/analyst-actions — backs the Analyst Actions screen's live
 * consensus card (the `AnalystConsensusDoc` shape). Live-direct: fetched per
 * request from the source job, no Firestore cache. There is no analyst-ratings
 * vendor wired (Polygon has no analyst endpoint), so the live response is [].
 */
@Controller("market-data")
export class AnalystActionsController {
  constructor(private readonly job: AnalystActionsJob) {}

  @Get("analyst-actions")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async analystActions() {
    return this.job.fetchLive();
  }
}
