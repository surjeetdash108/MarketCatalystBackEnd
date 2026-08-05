import { Injectable } from '@nestjs/common';
import {
  diffGroupedDaily,
  isMoverEligible,
  quarantineReason,
  type QuarantineReason,
} from '../vendors/polygon/polygon-diff.util';
import { PolygonService } from '../vendors/polygon/polygon.service';
import {
  AdapterResult,
  AdapterWarning,
  CanonicalMoverBase,
  MoversAdapter,
} from './types';

const QUARANTINE_LABEL: Record<QuarantineReason, string> = {
  split: 'a split executed between the two comparison days, so its close-to-close %change is a pre-split/post-split artifact',
  'extreme-move': 'its close-to-close %change is beyond the plausible-move threshold',
};

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
    const { date, priorDate, quotes, splitTickers } = await diffGroupedDaily(
      this.polygon,
    );
    const eligible = quotes.filter(isMoverEligible);
    const clean: CanonicalMoverBase[] = [];
    const quarantined: Array<{ mover: CanonicalMoverBase; reason: QuarantineReason }> =
      [];
    for (const m of eligible) {
      const reason = quarantineReason(m, splitTickers);
      if (reason) quarantined.push({ mover: m, reason });
      else clean.push(m);
    }
    const gainers = [...clean]
      .sort((a, b) => b.pctChange - a.pctChange)
      .slice(0, topN);
    const losers = [...clean]
      .sort((a, b) => a.pctChange - b.pctChange)
      .slice(0, topN);
    const warnings: AdapterWarning[] = [];
    if (clean.length === 0) {
      warnings.push({
        code: 'SUB_REQUEST_FAILED',
        message: `No tickers passed the mover-eligibility filter for ${date} — check whether the filter thresholds still match current market conditions.`,
      });
    }
    for (const { mover, reason } of quarantined) {
      warnings.push({
        code: 'DATA_QUARANTINED',
        field: mover.ticker,
        message: `${mover.ticker} held back from the board (${mover.pctChange > 0 ? '+' : ''}${mover.pctChange}% ${priorDate}→${date}): ${QUARANTINE_LABEL[reason]}.`,
      });
    }
    return {
      data: { date, gainers, losers },
      source: this.sourceName,
      warnings,
    };
  }
}
