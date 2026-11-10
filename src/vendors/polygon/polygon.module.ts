import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PolygonService } from "./polygon.service";
import { FmpModule } from "../fmp/fmp.module";
import { FmpService } from "../fmp/fmp.service";
import { SecEdgarModule } from "../sec-edgar/sec-edgar.module";
import { SecEdgarService } from "../sec-edgar/sec-edgar.service";
import { MarketDataService } from "../market-data/market-data.service";

/**
 * Every live screen, sync job and adapter injects PolygonService. By default
 * that token resolves to MarketDataService — FMP primary, Polygon as backup
 * (see market-data.service.ts). MARKET_DATA_PRIMARY=polygon restores plain
 * Polygon everywhere, e.g. as an instant rollback during an FMP incident.
 */
@Module({
  imports: [FmpModule, SecEdgarModule],
  providers: [
    {
      provide: PolygonService,
      inject: [ConfigService, FmpService, SecEdgarService],
      useFactory: (config: ConfigService, fmp: FmpService, sec: SecEdgarService) =>
        String(config.get("MARKET_DATA_PRIMARY", "fmp")).trim().toLowerCase() === "polygon"
          ? new PolygonService(config, fmp)
          : new MarketDataService(config, fmp, sec),
    },
  ],
  exports: [PolygonService],
})
export class PolygonModule {}
