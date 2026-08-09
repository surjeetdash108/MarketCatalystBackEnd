import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { AnalystActionsController } from './analyst-actions.controller';
import { CompaniesController } from './companies.controller';
import { DividendsController } from './dividends.controller';
import { EarningsController } from './earnings.controller';
import { EarningsAnnouncementsController } from './earnings-announcements.controller';
import { FilingsWireController } from './filings-wire.controller';
import { IpoPipelineController } from './ipo-pipeline.controller';
import { MacroRegimeController } from './macro-regime.controller';
import { InsiderPositionsController } from './insider-positions.controller';
import { InsiderTransactionsController } from './insider-transactions.controller';
import { IposController } from './ipos.controller';
import { MacroEventsController } from './macro-events.controller';
import { MarketDataService } from './market-data.service';
import { MarketMoversController } from './market-movers.controller';
import { MarketSentimentController } from './market-sentiment.controller';
import { NewsController } from './news.controller';
import { RecapsController } from './recaps.controller';
import { SectorsController } from './sectors.controller';

/**
 * Screen-facing read module for market-wide (non-user-owned) data — Movers,
 * Heatmap, Analyst, Screener, Themes, Earnings, IPOs, Macro, the Insider
 * transaction feed (Phase 2), and the Dashboard's remaining live widgets
 * (Phase 3: Fear & Greed via `market-sentiment`, everything else reusing the
 * Phase 2 endpoints). Public reads, same as LiveModule (no
 * FirebaseAuthGuard) — imports LiveModule for CachedCollectionsService.
 *
 * `MarketDataService.ensureFresh()` calls into `SyncRegistry`, whose job
 * runners are only *registered* by the sync job providers living in
 * SyncModule (worker-role only, see app.module.ts). Locally APP_ROLE is
 * unset so everything mounts in one process and this works as designed; in
 * a deployed two-service split, this module's on-demand triggers only take
 * effect where SyncModule is also mounted in the same process — flagged as
 * a follow-up, not a blocker for local verification.
 */
@Module({
  imports: [LiveModule],
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
  providers: [MarketDataService],
})
export class MarketDataModule {}
