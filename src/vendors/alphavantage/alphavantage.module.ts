import { Module } from '@nestjs/common';
import { AlphaVantageService } from './alphavantage.service';

@Module({
  providers: [AlphaVantageService],
  exports: [AlphaVantageService],
})
export class AlphaVantageModule {}
