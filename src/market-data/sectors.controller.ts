import { Controller, Get, Header } from '@nestjs/common';
import { CachedCollectionsService } from '../live/cached-collections.service';
import { MarketDataService } from './market-data.service';

/**
 * GET /market-data/sectors — backs the Market Heatmap screen's per-sector
 * `pctChange` (the `SectorApiDoc` shape). Triggers the `sectors` sync job on
 * demand when stale/empty per decision #3a.
 */
@Controller('market-data')
export class SectorsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get('sectors')
  @Header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
  async sectors() {
    await this.marketData.ensureFresh('sectors');
    const { sectors } = await this.cached.get(['sectors']);
    return sectors;
  }
}
