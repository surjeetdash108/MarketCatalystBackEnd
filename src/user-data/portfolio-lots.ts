/**
 * Transaction math for portfolio holdings (buys and sells).
 *
 * A holding is the replay of its transactions in trade-date order, using the
 * AVERAGE-COST method most retail brokers and trackers show:
 *
 *   BUY  q @ p  → shares += q, cost basis += q × p, average = cost / shares
 *   SELL q @ p  → realized P/L += q × (p − average), shares −= q, and the cost
 *                 basis drops by q × average, so the AVERAGE DOES NOT CHANGE
 *
 * Selling every share closes the position: the average resets, and a later
 * buy starts a fresh one. A sale can never exceed the shares held on its own
 * trade date — back-dated sales are checked against the replayed position.
 *
 * Kept free of Firestore and Nest so it can be unit tested directly.
 */

export type TxnType = "buy" | "sell";

export interface Lot {
  id: string;
  type: TxnType;
  shares: number;
  /** Price per share. Null only for a pre-transactions holding migrated as
   *  one buy without a recorded cost. */
  price: number | null;
  /** Trade date, YYYY-MM-DD. */
  date: string;
  /** ISO timestamp the transaction was recorded — breaks same-day ties. */
  createdAt: string;
  /** True for the buy synthesized from a holding saved before transactions
   *  existed. Internal only; it is shown as a normal buy. */
  opening?: boolean;
}

export interface LotWithRunning extends Lot {
  /** shares × price; null when the transaction has no price. */
  amount: number | null;
  /** Realized P/L of a sell; null for buys or an unpriced sale. */
  realizedPL: number | null;
  /** Shares held right after this transaction. */
  sharesAfter: number;
  /** Average cost per share right after this transaction; null when no
   *  shares are held or none carry a price. */
  avgCostAfter: number | null;
}

export interface LotSummary {
  shares: number;
  /** Average cost per share of the open position; null when closed. */
  avgCost: number | null;
  /** Cost basis of the open position (shares × average). */
  totalCost: number | null;
  /** Sum of realized P/L across all sells. */
  realizedPL: number;
  /** True when part of the open position has no recorded price, so avgCost
   *  covers only the priced shares. */
  partialCost: boolean;
  firstDate: string | null;
  lastDate: string | null;
  lotCount: number;
  buyCount: number;
  sellCount: number;
}

/** A sale that exceeds the shares held on its trade date. */
export class OversellError extends Error {
  constructor(
    readonly date: string,
    readonly held: number,
    readonly attempted: number,
  ) {
    super(`Sell of ${attempted} on ${date} exceeds ${held} shares held`);
    this.name = "OversellError";
  }
}

/** Tolerance for fractional-share float noise when comparing share counts. */
const EPS = 1e-9;

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

interface Replay {
  rows: LotWithRunning[]; // chronological
  shares: number;
  pricedShares: number;
  cost: number;
  realizedPL: number;
}

/** Replays transactions oldest-first. Throws OversellError on a bad sale. */
function replay(lots: Lot[]): Replay {
  let shares = 0;
  let pricedShares = 0; // shares that carry a recorded cost
  let cost = 0; // cost basis of the priced shares
  let realizedPL = 0;
  const rows: LotWithRunning[] = [];

  for (const lot of chronological(lots)) {
    let realized: number | null = null;
    if (lot.type === "sell") {
      if (lot.shares > shares + EPS)
        throw new OversellError(lot.date, clean(shares), lot.shares);
      const avg = pricedShares > EPS ? cost / pricedShares : null;
      if (avg != null && lot.price != null) {
        realized = lot.shares * (lot.price - avg);
        realizedPL += realized;
      }
      // Remove the sold shares pro rata, so the average is unchanged.
      const fraction = shares > EPS ? lot.shares / shares : 1;
      pricedShares -= pricedShares * fraction;
      cost -= cost * fraction;
      shares -= lot.shares;
      if (shares <= EPS) {
        // Position closed — the next buy starts a fresh average.
        shares = 0;
        pricedShares = 0;
        cost = 0;
      }
    } else {
      shares += lot.shares;
      if (lot.price != null) {
        pricedShares += lot.shares;
        cost += lot.shares * lot.price;
      }
    }
    rows.push({
      ...lot,
      amount: lot.price != null ? clean(lot.shares * lot.price) : null,
      realizedPL: realized != null ? clean(realized) : null,
      sharesAfter: clean(shares),
      avgCostAfter: pricedShares > EPS ? clean(cost / pricedShares) : null,
    });
  }
  return { rows, shares, pricedShares, cost, realizedPL };
}

export function summarizeLots(lots: Lot[]): LotSummary {
  const r = replay(lots);
  const open = r.shares > EPS;
  const ordered = r.rows;
  return {
    shares: clean(r.shares),
    avgCost:
      open && r.pricedShares > EPS ? clean(r.cost / r.pricedShares) : null,
    totalCost: open && r.pricedShares > EPS ? clean(r.cost) : null,
    realizedPL: clean(r.realizedPL),
    partialCost: open && r.pricedShares < r.shares - EPS,
    firstDate: ordered[0]?.date ?? null,
    lastDate: ordered[ordered.length - 1]?.date ?? null,
    lotCount: ordered.length,
    buyCount: ordered.filter((l) => l.type === "buy").length,
    sellCount: ordered.filter((l) => l.type === "sell").length,
  };
}

/**
 * Each transaction with the position right after it, returned NEWEST FIRST
 * for display. The running figures are computed oldest-first, because that
 * is the order the position actually evolved in.
 */
export function withRunningTotals(lots: Lot[]): LotWithRunning[] {
  return replay(lots).rows.reverse();
}
