import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { CommonModule } from './common/common.module';
import { HealthController } from './health/health.controller';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { RetentionModule } from './retention/retention.module';
import { AutoPurgeModule } from './auto-purge/auto-purge.module';
import { LiveModule } from './live/live.module';
import { PurgeModule } from './purge/purge.module';
import { SyncModule } from './sync/sync.module';
import { Wave3Module } from './vendors/wave3.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ScheduleModule.forRoot(),
    // Serves the backend monitor UI (public/index.html) at the root path.
    // `exclude` keeps the API routes from being shadowed by the static handler.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/health', '/sync/{*splat}', '/purge/{*splat}', '/live/{*splat}', '/feature-flags/{*splat}', '/retention/{*splat}'],
    }),
    CommonModule,
    SyncModule,
    PurgeModule,
    LiveModule,
    FeatureFlagsModule,
    RetentionModule,
    AutoPurgeModule,
    Wave3Module,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
