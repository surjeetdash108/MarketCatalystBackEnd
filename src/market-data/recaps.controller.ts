import { Controller, Get, NotImplementedException } from '@nestjs/common';

/**
 * GET /market-data/recaps — recaps.job.ts calls no vendor at all; it
 * aggregates market_indices/market_movers/sectors/market_breadth (plus their
 * _history siblings) into a frozen per-day snapshot. There's no single live
 * source to call directly, so this returns 501 rather than re-deriving a
 * "live" recap that contradicts its own frozen-snapshot design.
 */
@Controller('market-data')
export class RecapsController {
  @Get('recaps')
  recaps(): never {
    throw new NotImplementedException('not implemented');
  }
}
