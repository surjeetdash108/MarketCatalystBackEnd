import { Module } from '@nestjs/common';
import { FredService } from './fred.service';

@Module({
  providers: [FredService],
  exports: [FredService],
})
export class FredModule {}
