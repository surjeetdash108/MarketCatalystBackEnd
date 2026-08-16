import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { CommonModule } from "./common/common.module";
import { UserDataModule } from "./user-data/user-data.module";
import { FeatureFlagsModule } from "./feature-flags/feature-flags.module";
import { PlansModule } from "./plans/plans.module";
import { RetentionModule } from "./retention/retention.module";
import { AutoPurgeModule } from "./auto-purge/auto-purge.module";
import { LiveModule } from "./live/live.module";
import { MarketDataModule } from "./market-data/market-data.module";
import { PurgeModule } from "./purge/purge.module";
import { SyncModule } from "./sync/sync.module";
import { ApiHealthModule } from "./api-health/api-health.module";
import { BlogsModule } from "./blogs/blogs.module";

/**
 * Module graph for the Cloud Run Job entrypoint (job-entry.ts).
 *
 * It mirrors the worker's provider set EXACTLY, minus ServeStaticModule and the
 * HTTP controllers. `NestFactory.createApplicationContext()` boots no HTTP
 * server, so ServeStaticModule — which attaches static middleware to the HTTP
 * adapter — would crash the job on boot. Everything else is imported so every
 * sync job's dependencies resolve identically to the running worker (the
 * premarket bundle pulls OnDemandService from LiveModule for its warm phase and
 * touches most sync providers).
 *
 * ScheduleModule.forRoot() is required because CommonModule's ApiUsageService
 * declares an @Interval; its handler is harmless in a short-lived job (nothing
 * buffered to flush), and the @Cron purge/retention handlers are gated off by
 * ENABLE_SCHEDULED_JOBS. Jobs are invoked explicitly by name via SyncRegistry,
 * never by these decorators.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ".env" }),
    ScheduleModule.forRoot(),
    CommonModule,
    LiveModule,
    MarketDataModule,
    UserDataModule,
    PlansModule,
    ApiHealthModule,
    BlogsModule,
    SyncModule,
    PurgeModule,
    FeatureFlagsModule,
    RetentionModule,
    AutoPurgeModule,
  ],
})
export class AppJobModule {}
