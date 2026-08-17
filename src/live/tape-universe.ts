/**
 * What scrolls in the header ticker tape.
 *
 * The eight index tiles are copied VERBATIM from `INDEX_PROXIES` in
 * market-indices.job.ts — same symbols, labels, proxy tickers and notes. The
 * tape and the Dashboard's Market Pulse widget render the same nine instruments
 * from two different code paths (this one intraday, that one once a day at
 * 18:05 ET), so any divergence here shows up to the user as two tiles claiming
 * different values for "S&P 500" on the same screen.
 *
 * US10Y is deliberately NOT in `snapshotSymbols()`. It is not an equity: it
 * comes from `/fed/v1/treasury-yields`, a DAILY series, and it is quoted in
 * percentage POINTS rather than price. Putting it in the snapshot call would
 * return nothing; treating its `change` as a percentage would restate a 2bp
 * move as a 0.44% one — the same trap that made this tile an inverse TLT proxy
 * before the real yield was wired up.
 */

export type TapeKind = "index" | "stock" | "rate";

export interface TapeSymbol {
  /** Stable id the UI keys tiles and drawers on. */
  id: string;
  kind: TapeKind;
  label: string;
  /** The ticker actually sent to the vendor. Null for the rate tile. */
  proxyTicker: string | null;
  isProxy: boolean;
  note: string | null;
  /**
   * Index-level ≈ proxyTicker's price × multiplier. Polygon's real index
   * snapshot (`I:NDX`/`I:SPX`/…) is confirmed NOT_AUTHORIZED on this plan
   * (re-verified 2026-07-31), so this is the best available approximation —
   * only set where the ETF has a well-defined, stable share-to-index ratio
   * (SPY/DIA are literally structured as fixed fractions of their index; QQQ/
   * IWM are close enough to be far better than showing the raw ETF price).
   * Omitted (defaults to 1×) for GOLD/WTI/DXY/VIX, where the proxy ETF/ETN
   * has no reliable fixed ratio to the benchmark it tracks — a wrong-looking
   * multiplier there would be worse than an honest 1:1 proxy price.
   */
  multiplier?: number;
  /**
   * FRED series id for a REAL price (commodities / crypto), used instead of the
   * ETF proxy: the tile shows this value, not `proxyTicker`'s share price. FRED
   * is daily, so the price is end-of-day granularity but the true level (e.g.
   * gold ~$4,000/oz, BTC ~$100k) rather than GLD/IBIT's fund price.
   */
  fredSeries?: string;
}

/** Index tiles, via ETF proxies — the current plan does not include indices. */
export const TAPE_INDICES: TapeSymbol[] = [
  {
    id: "SPX",
    kind: "index",
    label: "S&P 500",
    proxyTicker: "SPY",
    isProxy: true,
    note: "ETF proxy for the S&P 500 index",
    multiplier: 10, // SPY is structured as ~1/10th of the S&P 500 by design.
  },
  {
    id: "NDX",
    kind: "index",
    label: "Nasdaq",
    proxyTicker: "QQQ",
    isProxy: true,
    note: "ETF proxy for the Nasdaq-100 index",
    // QQQ launched at 1/40th of NDX (1999) but has drifted since (expense
    // ratio drag) — 36.3 is the current ratio, verified against a live NDX
    // print (25,122.18) on 2026-07-31. Re-verify periodically; this drifts.
    multiplier: 36.3,
  },
  {
    id: "DJI",
    kind: "index",
    label: "Dow",
    proxyTicker: "DIA",
    isProxy: true,
    note: "ETF proxy for the Dow Jones index",
    multiplier: 100, // DIA is structured as ~1/100th of the DJIA by design.
  },
  {
    id: "RUT",
    kind: "index",
    label: "Russell 2000",
    proxyTicker: "IWM",
    isProxy: true,
    note: "ETF proxy for the Russell 2000 index",
    multiplier: 10, // Standard IWM≈RUT/10 approximation.
  },
  {
    id: "VIX",
    kind: "index",
    label: "VIX",
    proxyTicker: "VIXY",
    isProxy: true,
    note: "Decaying VIX futures ETN — directional proxy only, not the spot VIX level",
  },
  {
    id: "WTI",
    kind: "index",
    label: "WTI Crude",
    proxyTicker: null,
    isProxy: false,
    note: "WTI crude oil spot (FRED)",
    fredSeries: "DCOILWTICO", // real crude price, not the USO ETF
  },
  {
    id: "GOLD",
    kind: "index",
    label: "Gold",
    // FRED's LBMA gold series was discontinued (~2021), and GLD's raw share
    // price (~$400) is not the spot. But GLD holds physical gold (~0.0919 oz per
    // share), so spot ≈ GLD × 10.89 — live AND accurate to well under 1%, unlike
    // USO's roll-decay drift. The multiplier erodes only ~0.4%/yr (expense ratio).
    proxyTicker: "GLD",
    isProxy: true,
    note: "Spot gold ≈ GLD ETF × 10.89 (physical-gold backed)",
    multiplier: 10.89,
  },
  {
    id: "DXY",
    kind: "index",
    label: "Dollar (DXY)",
    proxyTicker: "UUP",
    isProxy: true,
    note: "ETF proxy for the US Dollar Index",
  },
  {
    id: "BTC",
    kind: "index",
    label: "Bitcoin",
    // Polygon/Massive carries no direct BTC/USD pair on this plan, and the IBIT
    // ETF proxy shows the fund's ~$35 share price, not the ~$100k spot. FRED's
    // Coinbase series carries the real BTC/USD price (daily granularity).
    proxyTicker: null,
    isProxy: false,
    note: "Bitcoin BTC/USD, Coinbase (FRED)",
    fredSeries: "CBBTCUSD",
  },
];

/** The rate tile. Sourced separately — see the docblock above. */
export const TAPE_RATE: TapeSymbol = {
  id: "US10Y",
  kind: "rate",
  label: "10Y Yield",
  proxyTicker: null,
  isProxy: false,
  note: "US Treasury 10-year constant-maturity yield, in percent",
};

/**
 * Default mega-cap tape. Chosen for liquidity and name recognition, not as a
 * recommendation — these are the names a reader expects to see scrolling.
 * Override with TAPE_STOCKS so the list is tunable without a deploy.
 */
const DEFAULT_TAPE_STOCKS = [
  "AAPL",
  "MSFT",
  "NVDA",
  "GOOGL",
  "AMZN",
  "META",
  "TSLA",
  "AVGO",
  "JPM",
  "V",
  "XOM",
  "LLY",
];

/** Guards the single upstream request against an absurd TAPE_STOCKS value. */
const MAX_TAPE_STOCKS = 40;
const TICKER_RE = /^[A-Z][A-Z.]{0,9}$/;

export function tapeStocks(raw?: string): TapeSymbol[] {
  const list = (raw ?? "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => TICKER_RE.test(t));
  const symbols = (list.length ? list : DEFAULT_TAPE_STOCKS).slice(
    0,
    MAX_TAPE_STOCKS,
  );
  return symbols.map((t) => ({
    id: t,
    kind: "stock" as const,
    // The tape shows the symbol, not the company name — it has to fit in a
    // scrolling strip. The vendor's `name` is carried on the item for the
    // drawer that opens when the tile is clicked.
    label: t,
    proxyTicker: t,
    isProxy: false,
    note: null,
  }));
}

/** Everything in tape order: indices, then the rate, then the stocks. */
export function tapeUniverse(rawStocks?: string): TapeSymbol[] {
  return [...TAPE_INDICES, TAPE_RATE, ...tapeStocks(rawStocks)];
}

/**
 * The one list sent to `/v3/snapshot?ticker.any_of=` — every tape entry that is
 * actually an equity. One request covers all of them.
 */
export function snapshotSymbols(universe: TapeSymbol[]): string[] {
  return universe
    .filter((s) => s.proxyTicker !== null)
    .map((s) => s.proxyTicker);
}
