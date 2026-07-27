import { Controller, Get, Header } from '@nestjs/common';
import { CachedCollectionsService } from '../live/cached-collections.service';
import { MarketDataService } from './market-data.service';

/**
 * GET /market-data/ipos — backs the IPO Corner screen's live calendar (the
 * `IpoEventDoc` shape). Triggers the `ipos` sync job on demand when
 * stale/empty per decision #3a.
 */
@Controller('market-data')
export class IposController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get('ipos')
  @Header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
  async ipos() {
    await this.marketData.ensureFresh('ipos');
    const { ipos } = await this.cached.get(['ipos']);
    return ipos;
  }
}
