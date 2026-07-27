import { Controller, Get, Header } from '@nestjs/common';
import { CachedCollectionsService } from '../live/cached-collections.service';
import { MarketDataService } from './market-data.service';

/**
 * GET /market-data/market-sentiment — backs the Dashboard's Fear & Greed
 * card (the `market_sentiment/fear_greed` doc). Triggers the `fear-greed`
 * sync job on demand when stale/empty per decision #3a.
 */
@Controller('market-data')
export class MarketSentimentController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get('market-sentiment')
  @Header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
  async marketSentiment() {
    await this.marketData.ensureFresh('fear-greed');
    const { market_sentiment } = await this.cached.get(['market_sentiment']);
    return market_sentiment;
  }
}
