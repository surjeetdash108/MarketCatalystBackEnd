import { Injectable, Logger } from "@nestjs/common";

@Injectable()
export class AnalystActionsJob {
  private readonly logger = new Logger(AnalystActionsJob.name);

  /**
   * Live-direct: there is NO analyst-ratings vendor wired (Polygon exposes no
   * analyst/consensus endpoint on any tier), so there is nothing to fetch — the
   * live response is an empty array, the same `AnalystConsensusDoc[]` shape the
   * `analyst_actions` collection read yielded. Backs GET
   * /market-data/analyst-actions.
   */
  async fetchLive(): Promise<Record<string, unknown>[]> {
    this.logger.warn(
      "analyst-actions: no ratings vendor configured (Polygon has no analyst endpoint) — returning [].",
    );
    return [];
  }
}
