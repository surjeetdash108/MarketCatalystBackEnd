export interface CanonicalCompany {
  ticker: string;
  /** Raw SEC SIC code the sector/industry were derived from, stored so the
   *  taxonomy can be recomputed later without re-hitting a vendor. Optional:
   *  adapters that have no SIC simply omit it. */
  sicCode?: string | null;
  sicDescription?: string | null;
  name: string | null;
  price: number | null;
  pctChange: number | null;
  marketCap: number | null;
  beta: number | null;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  week52Range: string | null;
  volume: number | null;
  averageVolume: number | null;
  description: string | null;
  peRatio: number | null;
  eps: number | null;
  dividendYield: number | null;
  dividendPerShare: number | null;
  peers: string[];
}

export interface CanonicalMoverBase {
  ticker: string;
  price: number;
  pctChange: number;
  volume: number;
  asOfDate: string;
}

export type CapBucket = "Mega" | "Large" | "Mid" | "Small" | "Micro";

export interface MoverEnrichment {
  name: string | null;
  sector: string | null;
  cap: CapBucket | null;
  /** Raw USD market cap from the same ticker-details fetch the `cap` tier is
   *  bucketed from — surfaced so the Movers table can show the real number,
   *  not just the tier. Null when the vendor has no market cap for the ticker. */
  marketCap: number | null;
}

export interface CanonicalNewsArticle {
  id: string;
  ticker: string;
  headline: string;
  summary: string | null;
  /** Publisher / outlet name (e.g. "Reuters", "Benzinga"). */
  source: string;
  /** Which data vendor delivered this article — "polygon" | "fmp". */
  vendor: string;
  url: string;
  category: string | null;
  sentiment: "positive" | "negative" | "neutral" | null;
  sentimentReasoning: string | null;
  keywords: string[];
  publishedAt: string;
  /** Article image, when the vendor supplies one. Used by the notification UI. */
  imageUrl: string | null;
}

export interface CanonicalDividendEvent {
  /** Vendor's stable per-event id; null when the vendor supplies none. */
  vendorEventId?: string | null;
  /** e.g. 'CD' regular cash, 'SC' special cash. Distinguishes same-day events. */
  dividendType?: string | null;
  symbol: string;
  date: string;
  recordDate: string | null;
  paymentDate: string | null;
  declarationDate: string | null;
  dividend: number;
  yield: number | null;
  frequency: string | null;
}

export interface CanonicalIpoEvent {
  date: string;
  symbol: string;
  name: string;
  exchange: string;
  /** Raw range string ("18.00-20.00"); parsed into low/high by the job. */
  price: string | null;
  numberOfShares: number | null;
  totalSharesValue: number | null;
  status: string;
}

export interface CanonicalSectorPerformance {
  date: string;
  sector: string;
  /** 'ETF-proxy' when derived from a sector ETF rather than a true index. */
  exchange: string;
  averageChange: number;
}

/** Canonical quote shape, which Polygon's getDailyQuote conforms to. */
export interface CanonicalQuote {
  c: number;
  d: number;
  dp: number;
  o: number;
  h: number;
  l: number;
  pc: number;
  t: number;
}

/** One daily OHLCV bar, already date-normalized — no vendor epoch fields. */
export interface CanonicalBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Volume-weighted average price for the bar. Optional because a future
   *  vendor may not supply one; Polygon has always returned it as `vw`. */
  vwap?: number | null;
}

/** Reference row for a listed symbol, camelCased away from Polygon's snake_case. */
export interface CanonicalTickerRef {
  ticker: string;
  name: string | null;
  market: string | null;
  locale: string | null;
  primaryExchange: string | null;
  type: string | null;
  active: boolean;
  currencyName: string | null;
  cik: string | null;
  compositeFigi: string | null;
  shareClassFigi: string | null;
}

export interface CanonicalIncomeStatement {
  fiscalYear: string | null;
  revenue: number | null;
  costOfRevenue: number | null;
  grossProfit: number | null;
  dilutedEps: number | null;
}

export interface AdapterWarning {
  code:
    | "SUB_REQUEST_FAILED"
    | "FIELD_NOT_SUPPORTED"
    | "FALLBACK_USED"
    | "STALE_DATA"
    | "DATA_QUARANTINED";
  message: string;
  field?: string;
}

export interface AdapterResult<T> {
  data: T;
  source: string;
  warnings: AdapterWarning[];
}

export interface CompanyProfileAdapter {
  readonly sourceName: string;
  fetchCompany(ticker: string): Promise<AdapterResult<CanonicalCompany> | null>;
}

export interface MoversAdapter {
  readonly sourceName: string;
  fetchTopMovers(topN: number): Promise<
    AdapterResult<{
      date: string;
      gainers: CanonicalMoverBase[];
      losers: CanonicalMoverBase[];
    }>
  >;
}

export interface MoverEnrichmentAdapter {
  readonly sourceName: string;
  enrichTicker(ticker: string): Promise<AdapterResult<MoverEnrichment> | null>;
}

export interface NewsAdapter {
  readonly sourceName: string;
  fetchNews(
    ticker: string,
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>>;
  /**
   * OPTIONAL market-wide newest-news fetch (no ticker filter), used to keep the
   * "Live" feed head current independent of the per-ticker cursor. Only vendors
   * with a market-wide endpoint implement it (Polygon does; FMP per-ticker does
   * not) — callers must feature-detect before calling.
   */
  fetchMarketNews?(
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>>;
}

export interface DividendsAdapter {
  readonly sourceName: string;
  fetchDividends(
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalDividendEvent[]>>;
}

export interface IposAdapter {
  readonly sourceName: string;
  fetchIpos(
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalIpoEvent[]>>;
}

export interface SectorsAdapter {
  readonly sourceName: string;
  fetchSectorPerformance(): Promise<
    AdapterResult<CanonicalSectorPerformance[]>
  >;
}

export interface QuoteAdapter {
  readonly sourceName: string;
  /** Null when the vendor has no quote for this symbol (not an error). */
  fetchQuote(ticker: string): Promise<AdapterResult<CanonicalQuote> | null>;
}

export interface MarketBarsAdapter {
  readonly sourceName: string;
  /**
   * How long a caller should wait between per-ticker calls to this source.
   * Pacing is a property of the vendor's rate limit, not of the job, so it
   * travels with the adapter — a vendor with no limit reports 0.
   */
  readonly requestDelayMs: number;
  fetchDailyBars(
    ticker: string,
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalBar[]>>;
}

export interface TickerUniverseAdapter {
  readonly sourceName: string;
  fetchAllTickers(
    activeOnly: boolean,
  ): Promise<AdapterResult<CanonicalTickerRef[]>>;
}

export interface FinancialsAdapter {
  readonly sourceName: string;
  /** See MarketBarsAdapter.requestDelayMs. */
  readonly requestDelayMs: number;
  fetchIncomeStatements(
    ticker: string,
    timeframe: string,
    limit: number,
  ): Promise<AdapterResult<CanonicalIncomeStatement[]>>;
}

export const COMPANY_PROFILE_ADAPTER: unique symbol = Symbol(
  "COMPANY_PROFILE_ADAPTER",
);
export const MOVERS_ADAPTER: unique symbol = Symbol("MOVERS_ADAPTER");
export const MOVER_ENRICHMENT_ADAPTER: unique symbol = Symbol(
  "MOVER_ENRICHMENT_ADAPTER",
);
export const NEWS_ADAPTER: unique symbol = Symbol("NEWS_ADAPTER");
/** Optional TradingView news source, merged alongside Polygon and FMP.
 *  Inert unless TRADINGVIEW_NEWS_URL points at a LICENSED feed. */
export const NEWS_TRADINGVIEW_ADAPTER: unique symbol = Symbol(
  "NEWS_TRADINGVIEW_ADAPTER",
);
/** Optional FMP news source, merged alongside NEWS_ADAPTER (Polygon). */
export const NEWS_FMP_ADAPTER: unique symbol = Symbol("NEWS_FMP_ADAPTER");
export const DIVIDENDS_ADAPTER: unique symbol = Symbol("DIVIDENDS_ADAPTER");
export const IPOS_ADAPTER: unique symbol = Symbol("IPOS_ADAPTER");
export const SECTORS_ADAPTER: unique symbol = Symbol("SECTORS_ADAPTER");
export const QUOTE_ADAPTER: unique symbol = Symbol("QUOTE_ADAPTER");
export const MARKET_BARS_ADAPTER: unique symbol = Symbol("MARKET_BARS_ADAPTER");
export const TICKER_UNIVERSE_ADAPTER: unique symbol = Symbol(
  "TICKER_UNIVERSE_ADAPTER",
);
export const FINANCIALS_ADAPTER: unique symbol = Symbol("FINANCIALS_ADAPTER");
/** Optional (FMP) earnings-estimates seam; null when EARNINGS_ESTIMATES_SOURCE=none. */
export const EARNINGS_ESTIMATES_ADAPTER: unique symbol = Symbol(
  "EARNINGS_ESTIMATES_ADAPTER",
);
/** Optional (FMP) analyst-ratings seam; null when ANALYST_SOURCE=none. */
export const ANALYST_RATINGS_ADAPTER: unique symbol = Symbol(
  "ANALYST_RATINGS_ADAPTER",
);

export function capBucket(marketCap: number | null): CapBucket | null {
  if (marketCap == null) return null;
  if (marketCap >= 200e9) return "Mega";
  if (marketCap >= 10e9) return "Large";
  if (marketCap >= 2e9) return "Mid";
  if (marketCap >= 300e6) return "Small";
  return "Micro";
}
