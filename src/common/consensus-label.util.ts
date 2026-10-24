/**
 * The ONE analyst-consensus label rule, used wherever a label is derived from
 * rating tallies (FMP grades-historical, the active-coverage fallback).
 *
 * Mean of the ratings on the standard 1–5 scale (Strong Buy = 1 … Strong
 * Sell = 5), bucketed the way Yahoo / LSEG publish it: ≤ 1.5 Strong Buy,
 * ≤ 2.5 Buy, ≤ 3.5 Hold, ≤ 4.5 Sell, else Strong Sell. Null with no ratings.
 */
export interface RatingTallies {
  strongBuy?: number | null;
  buy?: number | null;
  hold?: number | null;
  sell?: number | null;
  strongSell?: number | null;
}

export function consensusMean(t: RatingTallies): number | null {
  const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const total = n(t.strongBuy) + n(t.buy) + n(t.hold) + n(t.sell) + n(t.strongSell);
  if (total <= 0) return null;
  return (n(t.strongBuy) * 1 + n(t.buy) * 2 + n(t.hold) * 3 + n(t.sell) * 4 + n(t.strongSell) * 5) / total;
}

export function consensusLabel(t: RatingTallies): string | null {
  const score = consensusMean(t);
  if (score == null) return null;
  return score <= 1.5 ? "Strong Buy" : score <= 2.5 ? "Buy" : score <= 3.5 ? "Hold" : score <= 4.5 ? "Sell" : "Strong Sell";
}
