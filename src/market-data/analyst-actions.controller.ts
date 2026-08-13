import { Controller, Get, NotImplementedException } from '@nestjs/common';

/**
 * GET /market-data/analyst-actions — no analyst-ratings vendor is wired
 * (Polygon exposes no analyst/ratings/consensus endpoint on any tier, and the
 * interim ratings source has been removed — see analyst-actions.job.ts).
 * There is no source left to call directly, so this returns 501 rather than
 * silently serving stale/empty cached data.
 */
@Controller('market-data')
export class AnalystActionsController {
  @Get('analyst-actions')
  analystActions(): never {
    throw new NotImplementedException('not implemented');
  }
}
