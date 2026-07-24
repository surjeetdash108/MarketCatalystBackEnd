import { Module } from '@nestjs/common';
import { PolygonModule } from '../vendors/polygon/polygon.module';
import { LiveController } from './live.controller';
import { PolygonLiveService } from './polygon-live.service';
import { SnapshotCacheService } from './snapshot-cache.service';
import { SnapshotController } from './snapshot.controller';
import { MarketStatusService } from './market-status.service';
import { TapeController } from './tape.controller';
import { TapeService } from './tape.service';
import { CachedCollectionsController } from './cached-collections.controller';
import { CachedCollectionsService } from './cached-collections.service';
import { WhoamiController } from './whoami.controller';

/**
 * Live (delayed) price streaming for the Search screen and the header tape.
 *
 * Deliberately separate from SyncModule: the sync jobs are scheduled batch
 * work that runs and exits, whereas this holds a long-lived socket. Keeping
 * them apart makes it obvious that only this module needs a warm instance.
 *
 * That separation is now load-bearing rather than documentary: this is the ONLY
 * module the public `APP_ROLE=live` service mounts. See src/app.module.ts.
 */
@Module({
  imports: [PolygonModule],
  controllers: [LiveController, SnapshotController, TapeController, CachedCollectionsController, WhoamiController],
  providers: [PolygonLiveService, SnapshotCacheService, MarketStatusService, TapeService, CachedCollectionsService],
  exports: [PolygonLiveService, SnapshotCacheService, MarketStatusService, TapeService, CachedCollectionsService],
})
export class LiveModule {}
