import { Controller, Get } from "@nestjs/common";
import { LiveAnalystActionsService } from "./live-analyst-actions.service";

/**
 * GET /market-data/analyst-actions — backs the Analyst Actions screen's live
 * consensus card + the Dashboard/Stock consensus lookups (the
 * `AnalystConsensusDoc` shape). Served LIVE per request from FMP grades
 * consensus over a curated large-cap universe (no Firestore cache, no sync
 * job); concurrent requests are coalesced for a few seconds in the service.
 */
@Controller("market-data")
export class AnalystActionsController {
  constructor(private readonly liveAnalyst: LiveAnalystActionsService) {}

  @Get("analyst-actions")
  async analystActions() {
    return this.liveAnalyst.getAnalystActions();
  }
}
