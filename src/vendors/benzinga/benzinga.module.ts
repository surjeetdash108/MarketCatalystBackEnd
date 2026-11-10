import { Module } from "@nestjs/common";
import { BenzingaService } from "./benzinga.service";

@Module({
  providers: [BenzingaService],
  exports: [BenzingaService],
})
export class BenzingaModule {}
