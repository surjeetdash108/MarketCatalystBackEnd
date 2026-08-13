import { Module } from "@nestjs/common";
import { FmpModule } from "../vendors/fmp/fmp.module";
import { PolygonModule } from "../vendors/polygon/polygon.module";
import { FredModule } from "../vendors/fred/fred.module";
import { SecEdgarModule } from "../vendors/sec-edgar/sec-edgar.module";
import { AdaptersModule } from "../adapters/adapters.module";
import { LiveModule } from "../live/live.module";
import { AnalystActionsController } from "./analyst-actions.controller";
import { CompaniesController } from "./companies.controller";
import { DividendsController } from "./dividends.controller";
import { EarningsController } from "./earnings.controller";
import { EarningsAnnouncementsController } from "./earnings-announcements.controller";
import { FilingsWireController } from "./filings-wire.controller";
import { IpoPipelineController } from "./ipo-pipeline.controller";
import { MacroRegimeController } from "./macro-regime.controller";
import { InsiderPositionsController } from "./insider-positions.controller";
import { InsiderTransactionsController } from "./insider-transactions.controller";
import { IposController } from "./ipos.controller";
import { MacroEventsController } from "./macro-events.controller";
import { MarketMoversController } from "./market-movers.controller";
import { MarketSentimentController } from "./market-sentiment.controller";
import { NewsController } from "./news.controller";
import { RecapsController } from "./recaps.controller";
import { SectorsController } from "./sectors.controller";
import { MarketIndicesJob } from "../sync/market-indices.job";
// Former sync jobs — now retained ONLY for their live fetch+shape logic (the
// cron/registry machinery and all Firestore-write run() bodies were removed).
// The controllers below call each job's live method, which fetches from the
// vendor per request with no Firestore cache read/write. This module is the
// sole declarer of these providers (SyncModule was retired), so the live reads
// work in both the worker and the public `live` role.
import { AnalystActionsJob } from "../sync/analyst-actions.job";
import { CompaniesJob } from "../sync/companies.job";
import { DividendsJob } from "../sync/dividends.job";
import { Edgar8KJob } from "../sync/edgar-8k.job";
import { EdgarIpoPipelineJob } from "../sync/edgar-ipo-pipeline.job";
import { FearGreedJob } from "../sync/fear-greed.job";
import { IposJob } from "../sync/ipos.job";
import { MacroEventsJob } from "../sync/macro-events.job";
import { MacroRegimeJob } from "../sync/macro-regime.job";
import { NewsJob } from "../sync/news.job";
import { RecapsJob } from "../sync/recaps.job";
import { Sec13FJob } from "../sync/sec-13f.job";
import { SecForm4Job } from "../sync/sec-form4.job";
import { SectorsJob } from "../sync/sectors.job";

/**
 * Screen-facing read module for market-wide (non-user-owned) data — Movers,
 * Heatmap, Analyst, Screener, Themes, Earnings, IPOs, Macro, the Insider
 * transaction feed and the Dashboard's live widgets. Public reads, same as
 * LiveModule (no FirebaseAuthGuard).
 *
 * Every endpoint here is LIVE-DIRECT: the controller calls the matching sync
 * job's live method, which fetches from the vendor per request and returns the
 * shaped array WITHOUT reading a Firestore cache. Vendor modules are imported so
 * those jobs resolve their adapters/services in this module's injector.
 */
@Module({
  imports: [
    LiveModule,
    FmpModule,
    PolygonModule,
    FredModule,
    SecEdgarModule,
    AdaptersModule,
  ],
  controllers: [
    MarketMoversController,
    SectorsController,
    CompaniesController,
    AnalystActionsController,
    EarningsController,
    EarningsAnnouncementsController,
    FilingsWireController,
    IpoPipelineController,
    MacroRegimeController,
    IposController,
    MacroEventsController,
    DividendsController,
    InsiderTransactionsController,
    InsiderPositionsController,
    MarketSentimentController,
    NewsController,
    RecapsController,
  ],
  providers: [
    AnalystActionsJob,
    CompaniesJob,
    DividendsJob,
    Edgar8KJob,
    EdgarIpoPipelineJob,
    FearGreedJob,
    IposJob,
    MacroEventsJob,
    MacroRegimeJob,
    MarketIndicesJob,
    NewsJob,
    RecapsJob,
    Sec13FJob,
    SecForm4Job,
    SectorsJob,
  ],
})
export class MarketDataModule {}
