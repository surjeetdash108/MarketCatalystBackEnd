/**
 * Purchase-lot math for portfolio holdings.
 *
 * A holding is the sum of its buy lots. Each lot records how many shares were
 * bought, at what price and on what date. The holding's average cost is the
 * share-weighted mean of the lot prices, the standard "average cost" method
 * brokers show.
 *
 * Kept free of Firestore and Nest so it can be unit tested directly.
 */

export interface Lot {
  id: string;
  shares: number;
  /** Price paid per share. Null only for an opening lot migrated from a
   *  holding that was saved before lots existed and never had a cost. */
  price: number | null;
  /** Trade date, YYYY-MM-DD. */
  date: string;
  /** ISO timestamp the lot was recorded — breaks ties between same-day buys. */
  createdAt: string;
  /** True for the lot synthesized from a pre-lots holding. */
  opening?: boolean;
}

export interface LotWithRunning extends Lot {
  /** shares × price for this lot; null when the lot has no price. */
  amount: number | null;
  /** Total shares held immediately after this lot. */
  sharesAfter: number;
  /** Average cost per share immediately after this lot. */
  avgCostAfter: number | null;
}

export interface LotSummary {
  shares: number;
  /** Share-weighted average price over lots that carry a price. */
  avgCost: number | null;
  /** Sum of shares × price over priced lots. */
  totalCost: number | null;
  /** True when at least one lot has no price, so avgCost covers only part of
   *  the position. */
  partialCost: boolean;
  firstDate: string | null;
  lastDate: string | null;
  lotCount: number;
}

/** Oldest first: by trade date, then by when it was recorded. */
export function chronological(lots: Lot[]): Lot[] {
  return [...lots].sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt),
  );
}

/** Rounds away binary float noise (e.g. 0.1 + 0.2) without losing real cents. */
function clean(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

export function summarizeLots(lots: Lot[]): LotSummary {
  const ordered = chronological(lots);
  let shares = 0;
  let pricedShares = 0;
  let totalCost = 0;
  let partialCost = false;
  for (const lot of ordered) {
    shares += lot.shares;
    if (lot.price == null) {
      partialCost = true;
    } else {
      pricedShares += lot.shares;
      totalCost += lot.shares * lot.price;
    }
  }
  return {
    shares: clean(shares),
    avgCost: pricedShares > 0 ? clean(totalCost / pricedShares) : null,
    totalCost: pricedShares > 0 ? clean(totalCost) : null,
    partialCost,
    firstDate: ordered[0]?.date ?? null,
    lastDate: ordered[ordered.length - 1]?.date ?? null,
    lotCount: ordered.length,
  };
}

/**
 * Each lot with the position's running totals after it, returned NEWEST FIRST
 * for display. The running figures are computed oldest-first, because that is
 * the order the average actually evolved in.
 */
export function withRunningTotals(lots: Lot[]): LotWithRunning[] {
  let shares = 0;
  let pricedShares = 0;
  let totalCost = 0;
  const rows = chronological(lots).map((lot) => {
    shares += lot.shares;
    if (lot.price != null) {
      pricedShares += lot.shares;
      totalCost += lot.shares * lot.price;
    }
    return {
      ...lot,
      amount: lot.price != null ? clean(lot.shares * lot.price) : null,
      sharesAfter: clean(shares),
      avgCostAfter: pricedShares > 0 ? clean(totalCost / pricedShares) : null,
    };
  });
  return rows.reverse();
}
