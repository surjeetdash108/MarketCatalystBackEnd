import { Module } from "@nestjs/common";
import { AdaptersModule } from "../adapters/adapters.module";
import { PolygonModule } from "../vendors/polygon/polygon.module";
import { FmpModule } from "../vendors/fmp/fmp.module";
import { LiveController } from "./live.controller";
import { PolygonLiveService } from "./polygon-live.service";
import { SnapshotCacheService } from "./snapshot-cache.service";
import { SnapshotController } from "./snapshot.controller";
import { MarketStatusService } from "./market-status.service";
import { TapeController } from "./tape.controller";
import { TapeService } from "./tape.service";
import { CachedCollectionsController } from "./cached-collections.controller";
import { CachedCollectionsService } from "./cached-collections.service";
import { WhoamiController } from "./whoami.controller";
import { OnDemandController } from "./ondemand.controller";
import { OnDemandService } from "./ondemand.service";
import { TickerSearchService } from "./ticker-search.service";
import { SearchedTickersService } from "./searched-tickers.service";

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
  imports: [PolygonModule, AdaptersModule, FmpModule],
  controllers: [
    LiveController,
    SnapshotController,
    TapeController,
    CachedCollectionsController,
    WhoamiController,
    OnDemandController,
  ],
  providers: [
    PolygonLiveService,
    SnapshotCacheService,
    MarketStatusService,
    TapeService,
    CachedCollectionsService,
    OnDemandService,
    TickerSearchService,
    SearchedTickersService,
  ],
  exports: [
    PolygonLiveService,
    SnapshotCacheService,
    MarketStatusService,
    TapeService,
    CachedCollectionsService,
    OnDemandService,
    TickerSearchService,
    SearchedTickersService,
  ],
})
export class LiveModule {}
