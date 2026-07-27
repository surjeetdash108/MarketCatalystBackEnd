import { Controller, Get, Header } from '@nestjs/common';
import { CachedCollectionsService } from '../live/cached-collections.service';
import { MarketDataService } from './market-data.service';

/**
 * GET /market-data/dividends — backs the Macro & VIX screen's live dividend
 * calendar (the `DividendDoc` shape). Triggers the `dividends` sync job on
 * demand when stale/empty per decision #3a.
 */
@Controller('market-data')
export class DividendsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get('dividends')
  @Header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
  async dividends() {
    await this.marketData.ensureFresh('dividends');
    const { dividends } = await this.cached.get(['dividends']);
    return dividends;
  }
}
