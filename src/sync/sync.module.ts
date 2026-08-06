import { Module } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { FinnhubModule } from '../vendors/finnhub/finnhub.module';
import { FredModule } from '../vendors/fred/fred.module';
import { PolygonModule } from '../vendors/polygon/polygon.module';
import { SecEdgarModule } from '../vendors/sec-edgar/sec-edgar.module';
import { AnalystActionsJob } from './analyst-actions.job';
import { CompaniesJob } from './companies.job';
import { DividendsJob } from './dividends.job';
import { EarningsJob } from './earnings.job';
import { IposJob } from './ipos.job';
import { MacroEventsJob } from './macro-events.job';
import { MarketIndicesJob } from './market-indices.job';
import { MarketMoversJob } from './market-movers.job';
import { MarketQuotesJob } from './market-quotes.job';
import { NewsJob } from './news.job';
import { OptionsChainsJob } from './options-chains.job';
import { FearGreedJob } from './fear-greed.job';
import { RecapsJob } from './recaps.job';
import { FundamentalsGrowthJob } from './fundamentals-growth.job';
import { FinancialsJob } from './financials.job';
import { IntradayBarsJob } from './intraday-bars.job';
import { CorporateActionsJob } from './corporate-actions.job';
import { MarketBreadthJob } from './market-breadth.job';
import { RsRatingJob } from './rs-rating.job';
import { TechRatingJob } from './tech-rating.job';
import { TechnicalIndicatorsJob } from './technical-indicators.job';
import { Sec13FJob } from './sec-13f.job';
import { SecForm4Job } from './sec-form4.job';
import { SectorsJob } from './sectors.job';
import { StockHistoryJob } from './stock-history.job';
import { SyncController } from './sync.controller';
import { TickerUniverseJob } from './ticker-universe.job';
import { PremarketJob } from './premarket.job';
import { LiveModule } from '../live/live.module';

@Module({
  imports: [
    PolygonModule,
    FinnhubModule,
    FredModule,
    SecEdgarModule,
    AdaptersModule,
    // For OnDemandService — the premarket warm fills the same cache the
    // on-demand endpoints serve from.
    LiveModule,
  ],
  controllers: [SyncController],
  providers: [
    MarketMoversJob,
    CompaniesJob,
    EarningsJob,
    SectorsJob,
    AnalystActionsJob,
    MarketIndicesJob,
    NewsJob,
    Sec13FJob,
    SecForm4Job,
    TickerUniverseJob,
    MacroEventsJob,
    IposJob,
    OptionsChainsJob,
    DividendsJob,
    StockHistoryJob,
    IntradayBarsJob,
    CorporateActionsJob,
    MarketQuotesJob,
    RsRatingJob,
    TechnicalIndicatorsJob,
    TechRatingJob,
    FundamentalsGrowthJob,
    FinancialsJob,
    MarketBreadthJob,
    FearGreedJob,
    RecapsJob,
    PremarketJob,
  ],
})
export class SyncModule {}
