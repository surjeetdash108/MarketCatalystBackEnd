import { Controller, Get, Header } from '@nestjs/common';
import { CachedCollectionsService } from '../live/cached-collections.service';
import { MarketDataService } from './market-data.service';

/**
 * GET /market-data/earnings — backs the Earnings Hub screen's live calendar
 * (the `LiveEarningsDoc` shape). Triggers the `earnings` sync job on demand
 * when stale/empty per decision #3a.
 */
@Controller('market-data')
export class EarningsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get('earnings')
  @Header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
  async earnings() {
    await this.marketData.ensureFresh('earnings');
    const { earnings_events } = await this.cached.get(['earnings_events']);
    return earnings_events;
  }
}
