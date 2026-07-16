import { Injectable } from '@nestjs/common';
import { diffGroupedDaily, isMoverEligible } from '../vendors/polygon/polygon-diff.util';
import { PolygonService } from '../vendors/polygon/polygon.service';
import {
  AdapterResult,
  AdapterWarning,
  CanonicalMoverBase,
  MoversAdapter,
} from './types';

@Injectable()
export class PolygonMoversAdapter implements MoversAdapter {
  readonly sourceName = 'polygon';

  constructor(private readonly polygon: PolygonService) {}

  async fetchTopMovers(topN: number): Promise<
    AdapterResult<{
      date: string;
      gainers: CanonicalMoverBase[];
      losers: CanonicalMoverBase[];
    }>
  > {
    const { date, quotes } = await diffGroupedDaily(this.polygon);
    const movers = quotes.filter(isMoverEligible);
    const gainers = [...movers]
      .sort((a, b) => b.pctChange - a.pctChange)
      .slice(0, topN);
    const losers = [...movers]
      .sort((a, b) => a.pctChange - b.pctChange)
      .slice(0, topN);
    const warnings: AdapterWarning[] =
      movers.length === 0
        ? [
            {
              code: 'SUB_REQUEST_FAILED',
              message: `No tickers passed the mover-eligibility filter for ${date} — check whether the filter thresholds still match current market conditions.`,
            },
          ]
        : [];
    return {
      data: { date, gainers, losers },
      source: this.sourceName,
      warnings,
    };
  }
}
