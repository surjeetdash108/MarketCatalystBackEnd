import { CanonicalMoverBase } from '../../adapters/types';
import { candidateTradingDays } from '../../common/trading-days.util';
import { PolygonService } from './polygon.service';

const MIN_PRICE = 3;
const MIN_VOLUME = 500_000;

export async function diffGroupedDaily(
  polygon: PolygonService,
): Promise<{ date: string; quotes: CanonicalMoverBase[] }> {
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
  return { date: today.date, quotes };
}

export function isMoverEligible(q: CanonicalMoverBase): boolean {
  return q.price >= MIN_PRICE && q.volume >= MIN_VOLUME;
}
