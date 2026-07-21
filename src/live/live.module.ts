import { Module } from '@nestjs/common';
import { PolygonModule } from '../vendors/polygon/polygon.module';
import { LiveController } from './live.controller';
import { PolygonLiveService } from './polygon-live.service';
import { SnapshotCacheService } from './snapshot-cache.service';
import { SnapshotController } from './snapshot.controller';
import { MarketStatusService } from './market-status.service';

/**
 * Live (delayed) price streaming for the Search screen.
 *
 * Deliberately separate from SyncModule: the sync jobs are scheduled batch
 * work that runs and exits, whereas this holds a long-lived socket. Keeping
 * them apart makes it obvious that only this module needs a warm instance.
 */
@Module({
  imports: [PolygonModule],
  controllers: [LiveController, SnapshotController],
  providers: [PolygonLiveService, SnapshotCacheService, MarketStatusService],
  exports: [PolygonLiveService, SnapshotCacheService, MarketStatusService],
})
export class LiveModule {}
