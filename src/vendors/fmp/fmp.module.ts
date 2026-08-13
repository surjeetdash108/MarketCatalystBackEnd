import { Module } from '@nestjs/common';
import { FmpService } from './fmp.service';

@Module({
  providers: [FmpService],
  exports: [FmpService],
})
export class FmpModule {}
