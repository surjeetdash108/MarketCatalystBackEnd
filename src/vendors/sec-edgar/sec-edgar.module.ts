import { Module } from '@nestjs/common';
import { SecEdgarService } from './sec-edgar.service';

@Module({
  providers: [SecEdgarService],
  exports: [SecEdgarService],
})
export class SecEdgarModule {}
