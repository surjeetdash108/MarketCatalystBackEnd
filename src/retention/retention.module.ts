import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module";
import { RetentionController } from "./retention.controller";
import { RetentionService } from "./retention.service";

@Module({
  imports: [CommonModule],
  controllers: [RetentionController],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
