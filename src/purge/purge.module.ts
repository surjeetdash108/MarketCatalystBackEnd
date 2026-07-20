import { Module } from '@nestjs/common';
import { PurgeController } from './purge.controller';
import { PurgeService } from './purge.service';

@Module({
  controllers: [PurgeController],
  providers: [PurgeService],
})
export class PurgeModule {}
