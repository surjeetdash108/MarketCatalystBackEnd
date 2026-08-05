import { CanonicalMoverBase } from '../../adapters/types';
import { candidateTradingDays } from '../../common/trading-days.util';
import { PolygonService } from './polygon.service';

const MIN_PRICE = 3;
const MIN_VOLUME = 500_000;

/**
 * Close-to-close moves at or above this magnitude are held back from the board
 * for review rather than published. A $3+, 500k-volume name genuinely closing
 * ±100% in one session is real-market extraordinary; when several appear at
 * once it is almost always a data artifact (an unadjusted corporate action, a
 * relisting/ticker-reuse gap, or a bad prior close), not a real leaderboard.
 * Quarantined — not silently dropped: each is surfaced as a warning so a real
 * move can be spotted and this threshold retuned.
 */
export const MAX_ABS_PCT_CHANGE = 100;

export type QuarantineReason = 'split' | 'extreme-move';

export interface GroupedDailyDiff {
  date: string;
  priorDate: string;
  quotes: CanonicalMoverBase[];
  /** Tickers whose split executed in (priorDate, date] — their close-to-close
   *  %change compares a pre-split price to a post-split one and is meaningless. */
  splitTickers: Set<string>;
}

export async function diffGroupedDaily(
  polygon: PolygonService,
): Promise<GroupedDailyDiff> {
  const today = await polygon.getLatestGroupedDaily(candidateTradingDays(new Date()));
  if (!today) {
    throw new Error(
      'No grouped-daily data found in the last 7 candidate days — Polygon may be down or every candidate day was a holiday/weekend',
    );
  }
  const dayBefore = new Date(`${today.date}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const prior = await polygon.getLatestGroupedDaily(candidateTradingDays(dayBefore));
  if (!prior) {
    throw new Error(
      `No prior trading day found before ${today.date} — cannot compute %change without a comparison day`,
    );
  }
  const splits = await polygon.getSplitsInRange(prior.date, today.date);
  const splitTickers = new Set(splits.map((s) => s.ticker));
  const priorByTicker = new Map(prior.bars.map((b) => [b.T, b]));
  const quotes = today.bars
    .map((bar): CanonicalMoverBase | null => {
      const prevBar = priorByTicker.get(bar.T);
      if (!prevBar || prevBar.c <= 0) return null;
      const pctChange = ((bar.c - prevBar.c) / prevBar.c) * 100;
      return {
        ticker: bar.T,
        price: bar.c,
        pctChange: Math.round(pctChange * 100) / 100,
        volume: bar.v,
        asOfDate: today.date,
      };
    })
    .filter((q): q is CanonicalMoverBase => q !== null);
  return { date: today.date, priorDate: prior.date, quotes, splitTickers };
}

export function isMoverEligible(q: CanonicalMoverBase): boolean {
  return q.price >= MIN_PRICE && q.volume >= MIN_VOLUME;
}

/**
 * Why an otherwise-eligible mover must be held back, or null if it is clean.
 * Split artifacts are checked first: a split makes the whole %change bogus, so
 * that is the more precise reason to report even when the number is also huge.
 */
export function quarantineReason(
  q: CanonicalMoverBase,
  splitTickers: Set<string>,
): QuarantineReason | null {
  if (splitTickers.has(q.ticker)) return 'split';
  if (Math.abs(q.pctChange) >= MAX_ABS_PCT_CHANGE) return 'extreme-move';
  return null;
}
