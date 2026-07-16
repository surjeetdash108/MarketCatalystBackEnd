import { Module } from '@nestjs/common';
import { BenzingaService } from './benzinga/benzinga.service';
import { TradierService } from './tradier/tradier.service';
import { UnusualWhalesService } from './unusual-whales/unusual-whales.service';

@Module({
  providers: [BenzingaService, TradierService, UnusualWhalesService],
  exports: [BenzingaService, TradierService, UnusualWhalesService],
})
export class Wave3Module {}
