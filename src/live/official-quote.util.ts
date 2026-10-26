import type { SnapshotQuote } from "./snapshot-cache.service";

export interface ExtendedQuote {
  session: "pre-market" | "after-hours";
  price: number;
  /** Move from the official close. */
  pctChange: number;
  /** Time of that trade (epoch ms), for the "as of" caption. */
  at: number | null;
}

export interface QuoteRow {
  ticker: string;
  name: null;
  /** Official 4:00 PM ET close outside regular hours; the live price during them. */
  price: number | null;
  /** That price's move from the previous official close (null when unknown). */
  pctChange: number | null;
  /** The latest extended-hours trade, when one has moved off the close. */
  extended: ExtendedQuote | null;
}

/**
 * The quote a list surface shows. Outside regular hours the snapshot's `price`
 * is the last extended-hours trade, and showing it as "the price" put an
 * after-hours print beside a day change measured to a different close (E2E
 * Oct 23: the header-search dropdown read PEP 135.86, the after-hours trade,
 * against the official 135.77). The official close (`regularClose`) is the
 * price; the extended trade travels separately with its time.
 *
 * Pre-market, the official close is the previous session's and its own day
 * move is not in the snapshot (previousClose = that same close), so
 * pctChange is null rather than 0 — callers fall back to their stored doc.
 */
export function quoteRow(q: SnapshotQuote): QuoteRow {
  const base: QuoteRow = { ticker: q.ticker, name: null, price: q.price ?? null, pctChange: q.changePct ?? null, extended: null };
  const status = q.marketStatus;
  const close = q.regularClose;
  if (status == null || status === "open" || close == null || !(close > 0)) return base;
  const pre = status === "early_trading";
  const pctChange = !pre && q.previousClose != null && q.previousClose > 0 ? ((close - q.previousClose) / q.previousClose) * 100 : null;
  const extended: ExtendedQuote | null =
    q.price != null && q.price > 0 && q.price !== close
      ? { session: pre ? "pre-market" : "after-hours", price: q.price, pctChange: ((q.price - close) / close) * 100, at: q.vendorUpdatedAt ?? null }
      : null;
  return { ticker: q.ticker, name: null, price: close, pctChange, extended };
}
