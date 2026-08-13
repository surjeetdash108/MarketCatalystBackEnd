import { Module } from "@nestjs/common";
import { AdaptersModule } from "../adapters/adapters.module";
import { FredModule } from "../vendors/fred/fred.module";
import { PolygonModule } from "../vendors/polygon/polygon.module";
import { SecEdgarModule } from "../vendors/sec-edgar/sec-edgar.module";
import { AnalystActionsJob } from "./analyst-actions.job";
import { CompaniesJob } from "./companies.job";
import { EarningsJob } from "./earnings.job";
import { MarketIndicesJob } from "./market-indices.job";
import { MarketQuotesJob } from "./market-quotes.job";
import { NewsJob } from "./news.job";
import { OptionsChainsJob } from "./options-chains.job";
import { RecapsJob } from "./recaps.job";
import { FundamentalsGrowthJob } from "./fundamentals-growth.job";
import { FinancialsJob } from "./financials.job";
import { IntradayBarsJob } from "./intraday-bars.job";
import { CorporateActionsJob } from "./corporate-actions.job";
import { MarketBreadthJob } from "./market-breadth.job";
import { RsRatingJob } from "./rs-rating.job";
import { TechRatingJob } from "./tech-rating.job";
import { TechnicalIndicatorsJob } from "./technical-indicators.job";
import { SecForm4Job } from "./sec-form4.job";
import { Edgar8KJob } from "./edgar-8k.job";
import { EdgarIpoPipelineJob } from "./edgar-ipo-pipeline.job";
// SectorsJob removed — /market-data/sectors is now served live per request by
// LiveSectorsService (see market-data/live-sectors.service.ts).
import { StockHistoryJob } from "./stock-history.job";
import { SyncController } from "./sync.controller";
import { TickerUniverseJob } from "./ticker-universe.job";
import { PremarketJob } from "./premarket.job";
import { LiveModule } from "../live/live.module";

@Module({
  imports: [
    PolygonModule,
    FredModule,
    SecEdgarModule,
    AdaptersModule,
    // For OnDemandService — the premarket warm fills the same cache the
    // on-demand endpoints serve from.
    LiveModule,
  ],
  controllers: [SyncController],
  providers: [
    CompaniesJob,
    EarningsJob,
    AnalystActionsJob,
    MarketIndicesJob,
    NewsJob,
    SecForm4Job,
    Edgar8KJob,
    EdgarIpoPipelineJob,
    TickerUniverseJob,
    OptionsChainsJob,
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
    RecapsJob,
    PremarketJob,
  ],
})
export class SyncModule {}
