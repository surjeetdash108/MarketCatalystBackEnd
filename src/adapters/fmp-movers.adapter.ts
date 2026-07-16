import { Injectable } from '@nestjs/common';
import { FmpService } from '../vendors/fmp/fmp.service';
import {
  AdapterResult,
  AdapterWarning,
  CanonicalMoverBase,
  MoversAdapter,
} from './types';

const MIN_PRICE = 3;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class FmpMoversAdapter implements MoversAdapter {
  readonly sourceName = 'fmp';

  constructor(private readonly fmp: FmpService) {}

  async fetchTopMovers(topN: number): Promise<
    AdapterResult<{
      date: string;
      gainers: CanonicalMoverBase[];
      losers: CanonicalMoverBase[];
    }>
  > {
    const [rawGainers, rawLosers] = await Promise.all([
      this.fmp.getBiggestGainers(),
      this.fmp.getBiggestLosers(),
    ]);
    const date = isoDate(new Date());
    const toMover = (row): CanonicalMoverBase | null => {
      if (row.price == null || row.price < MIN_PRICE) return null;
      return {
        ticker: row.symbol,
        price: row.price,
        pctChange: Math.round(row.changesPercentage * 100) / 100,
        volume: 0,
        asOfDate: date,
      };
    };
    const gainers = rawGainers
      .map(toMover)
      .filter((m) => m !== null)
      .slice(0, topN);
    const losers = rawLosers
      .map(toMover)
      .filter((m) => m !== null)
      .slice(0, topN);
    const warnings: AdapterWarning[] = [
      {
        code: 'FIELD_NOT_SUPPORTED',
        field: 'volume',
        message:
          "FMP's biggest-gainers/biggest-losers endpoints do not report volume — this source cannot populate it or apply a minimum-volume filter.",
      },
    ];
    return {
      data: { date, gainers, losers },
      source: this.sourceName,
      warnings,
    };
  }
}
