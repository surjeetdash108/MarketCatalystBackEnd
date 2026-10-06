import { Module } from "@nestjs/common";
import { PolygonService } from "./polygon.service";
import { FmpModule } from "../fmp/fmp.module";

@Module({
  imports: [FmpModule],
  providers: [PolygonService],
  exports: [PolygonService],
})
export class PolygonModule {}

