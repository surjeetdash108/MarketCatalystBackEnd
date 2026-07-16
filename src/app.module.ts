import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule } from './common/common.module';
import { HealthController } from './health/health.controller';
import { SyncModule } from './sync/sync.module';
import { Wave3Module } from './vendors/wave3.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ScheduleModule.forRoot(),
    CommonModule,
    SyncModule,
    Wave3Module,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
