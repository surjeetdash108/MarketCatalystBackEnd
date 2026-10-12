import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchJson, type FetchJsonOptions } from "../../common/http.util";

/**
 * Financial Modeling Prep (FMP) — a SUPPLEMENTARY vendor, wired only for the
 * data Polygon structurally cannot provide (earnings estimates/surprises,
 * analyst ratings) plus optional sector performance. It does not supply
 * OHLCV/news/corporate actions — those stay Polygon-owned. The one price path
 * it can own is the live quote cache, and only when `LIVE_QUOTE_SOURCE=fmp`
 * (snapshot-cache.service.ts); that swaps the single source rather than mixing
 * two, so there is still one source of truth for price at a time.
 *
 * Uses FMP's current `/stable/` API (the legacy `/api/v3` + `/api/v4` paths are
 * deprecated and now return 403). Auth is a `?apikey=` query param (redacted in
 * logs by http.util). Responses are parsed defensively — a field the plan/
 * version names differently degrades to null rather than throwing.
 *
 * Every FMP feature is opt-in behind a `<DOMAIN>_SOURCE` env var that defaults
 * to "none" (off). To remove FMP entirely: set every `*_SOURCE` back to "none",
 * then delete `src/vendors/fmp/` and the FMP adapters.
 */

const DEFAULT_BASE_URL = "https://financialmodelingprep.com/stable";

// Parses a vendor field to a finite number, else null. The old
// `Number(v) || null` had two data bugs: it turned a legitimate 0 into null
// (0 is falsy) — so a real "0 analysts" / "$0 estimate" vanished — and it let
// Infinity through (`Number("Infinity") || null` === Infinity). This preserves
// 0 and negatives, and rejects NaN/±Infinity.
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Maps one quote row; null when it carries no symbol or no usable price. */
const toFullQuote = (r: any): FmpFullQuote | null => {
  const price = num(r?.price);
  if (!r?.symbol || price == null) return null;
  return {
    symbol: String(r.symbol).toUpperCase(),
    price,
    change: num(r.change),
    changePercentage: num(r.changePercentage),
    previousClose: num(r.previousClose),
    open: num(r.open),
    dayHigh: num(r.dayHigh),
    dayLow: num(r.dayLow),
    volume: num(r.volume),
    timestamp: num(r.timestamp),
  };
};

/** Normalised earnings-calendar row (per report date, all companies). */
export interface FmpEarningRow {
  date: string;
  symbol: string;
  epsEstimated: number | null;
  revenueEstimated: number | null;
  // Reported actuals (present once a company has announced) — the announcement
  // date fills the ~2-week gap Polygon's 10-Q filing-date feed leaves.
  epsActual: number | null;
  revenueActual: number | null;
}

/** Normalised stock-news row (`/stable/news/stock`). `site` is the outlet. */
export interface FmpNewsRow {
  symbol: string | null;
  publishedDate: string;
  title: string;
  text: string | null;
  site: string | null;
  url: string;
  image: string | null;
  /** Sentiment label when the response carries one, else null. */
  sentiment: string | null;
}

/**
 * Normalised company profile (`/stable/profile`). Used to REFINE the sector
 * Polygon's SIC code produces (FMP carries a clean GICS `sector`/`industry`
 * where Polygon has only a free-text SIC that dumps e.g. Bitcoin miners into
 * "Finance Services"), and to supply `description`: FMP's is the fuller,
 * business-operations writeup (what most other portals show); Polygon's is a
 * shorter, more generic blurb. Price/marketCap/name stay Polygon-owned — this
 * never becomes a second price source.
 */
export interface FmpCompanyProfileRow {
  symbol: string;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  description: string | null;
}

/** One row of FMP /stable/income-statement. */
export interface FmpIncomeStatementRow {
  date: string;
  symbol: string;
  reportedCurrency?: string;
  cik?: string;
  filingDate?: string;
  acceptedDate?: string;
  fiscalYear?: string | number;
  period?: string;
  revenue?: number | null;
  costOfRevenue?: number | null;
  grossProfit?: number | null;
  researchAndDevelopmentExpenses?: number | null;
  generalAndAdministrativeExpenses?: number | null;
  sellingAndMarketingExpenses?: number | null;
  sellingGeneralAndAdministrativeExpenses?: number | null;
  otherExpenses?: number | null;
  operatingExpenses?: number | null;
  costAndExpenses?: number | null;
  interestIncome?: number | null;
  interestExpense?: number | null;
  depreciationAndAmortization?: number | null;
  ebitda?: number | null;
  ebit?: number | null;
  operatingIncome?: number | null;
  totalOtherIncomeExpensesNet?: number | null;
  incomeBeforeTax?: number | null;
  incomeTaxExpense?: number | null;
  netIncome?: number | null;
  eps?: number | null;
  epsDiluted?: number | null;
  weightedAverageShsOut?: number | null;
  weightedAverageShsOutDil?: number | null;
}

/** One row of FMP /stable/balance-sheet-statement. */
export interface FmpBalanceSheetRow {
  date: string;
  symbol: string;
  reportedCurrency?: string;
  cik?: string;
  filingDate?: string;
  acceptedDate?: string;
  fiscalYear?: string | number;
  period?: string;
  cashAndCashEquivalents?: number | null;
  shortTermInvestments?: number | null;
  cashAndShortTermInvestments?: number | null;
  netReceivables?: number | null;
  inventory?: number | null;
  otherCurrentAssets?: number | null;
  totalCurrentAssets?: number | null;
  propertyPlantEquipmentNet?: number | null;
  goodwill?: number | null;
  intangibleAssets?: number | null;
  goodwillAndIntangibleAssets?: number | null;
  longTermInvestments?: number | null;
  otherNonCurrentAssets?: number | null;
  totalNonCurrentAssets?: number | null;
  otherAssets?: number | null;
  totalAssets?: number | null;
  accountPayables?: number | null;
  shortTermDebt?: number | null;
  taxPayables?: number | null;
  deferredRevenue?: number | null;
  otherCurrentLiabilities?: number | null;
  totalCurrentLiabilities?: number | null;
  longTermDebt?: number | null;
  deferredRevenueNonCurrent?: number | null;
  otherNonCurrentLiabilities?: number | null;
  totalNonCurrentLiabilities?: number | null;
  otherLiabilities?: number | null;
  totalLiabilities?: number | null;
  commonStock?: number | null;
  retainedEarnings?: number | null;
  accumulatedOtherComprehensiveIncomeLoss?: number | null;
  totalStockholdersEquity?: number | null;
  totalEquity?: number | null;
  totalLiabilitiesAndTotalEquity?: number | null;
  totalDebt?: number | null;
  netDebt?: number | null;
}

/** One row of FMP /stable/cash-flow-statement. */
export interface FmpCashFlowRow {
  date: string;
  symbol: string;
  reportedCurrency?: string;
  cik?: string;
  filingDate?: string;
  acceptedDate?: string;
  fiscalYear?: string | number;
  period?: string;
  netIncome?: number | null;
  depreciationAndAmortization?: number | null;
  deferredIncomeTax?: number | null;
  stockBasedCompensation?: number | null;
  changeInWorkingCapital?: number | null;
  accountsReceivables?: number | null;
  inventory?: number | null;
  accountsPayables?: number | null;
  otherWorkingCapital?: number | null;
  otherNonCashItems?: number | null;
  netCashProvidedByOperatingActivities?: number | null;
  investmentsInPropertyPlantAndEquipment?: number | null;
  acquisitionsNet?: number | null;
  purchasesOfInvestments?: number | null;
  salesMaturitiesOfInvestments?: number | null;
  otherInvestingActivities?: number | null;
  netCashProvidedByInvestingActivities?: number | null;
  netDebtIssuance?: number | null;
  longTermNetDebtIssuance?: number | null;
  shortTermNetDebtIssuance?: number | null;
  netStockIssuance?: number | null;
  netCommonStockIssuance?: number | null;
  commonStockIssuance?: number | null;
  commonStockRepurchased?: number | null;
  netDividendsPaid?: number | null;
  commonDividendsPaid?: number | null;
  otherFinancingActivities?: number | null;
  netCashProvidedByFinancingActivities?: number | null;
  effectOfForexChangesOnCash?: number | null;
  netChangeInCash?: number | null;
  cashAtEndOfPeriod?: number | null;
  cashAtBeginningOfPeriod?: number | null;
  operatingCashFlow?: number | null;
  capitalExpenditure?: number | null;
  freeCashFlow?: number | null;
  incomeTaxesPaid?: number | null;
  interestPaid?: number | null;
}

/** Normalised analyst grades consensus (rating tallies + label). */
export interface FmpConsensusRow {
  symbol: string;
  strongBuy: number | null;
  buy: number | null;
  hold: number | null;
  sell: number | null;
  strongSell: number | null;
  consensus: string | null;
}

/** Normalised sector performance (one row per sector). */
export interface FmpSectorPerformanceRow {
  sector: string;
  changesPercentage: string | number | null;
}

/** Normalised forward annual estimate (avg EPS/revenue per fiscal year). */
export interface FmpAnalystEstimateRow {
  date: string;
  symbol: string;
  estimatedEpsAvg: number | null;
  estimatedRevenueAvg: number | null;
}

/** Normalised per-ticker earnings history row (actual vs estimate). */
export interface FmpEarningsSurpriseRow {
  date: string;
  symbol: string;
  actualEarningResult: number | null;
  estimatedEarning: number | null;
}

export type FmpStatementKind =
  "income-statement" | "balance-sheet-statement" | "cash-flow-statement";

/**
 * One period of one financial statement. Period labels are lifted out; every
 * numeric field is kept under its FMP name in `values` (each statement carries
 * 40–60 of them) and mapped onto the canonical vocabulary by the adapter.
 */
export interface FmpStatementRow {
  /** Period end date (YYYY-MM-DD) — the join key across the three statements. */
  date: string;
  fiscalYear: string | null;
  /** "Q1".."Q4" or "FY". */
  period: string | null;
  filingDate: string | null;
  /** ISO currency of every monetary value in the row (e.g. "USD", "TWD"). */
  reportedCurrency: string | null;
  values: Record<string, number | null>;
}

/** Analyst price-target consensus (high/low/avg/median across firms). */
export interface FmpPriceTargetConsensusRow {
  targetHigh: number | null;
  targetLow: number | null;
  targetConsensus: number | null;
  targetMedian: number | null;
}

/** Rolling average price target over recent windows (trend). */
export interface FmpPriceTargetSummaryRow {
  lastMonthCount: number | null;
  lastMonthAvg: number | null;
  lastQuarterCount: number | null;
  lastQuarterAvg: number | null;
  lastYearCount: number | null;
  lastYearAvg: number | null;
}

/** A single per-firm rating change (upgrade/downgrade/initiate/maintain). */
export interface FmpGradeRow {
  date: string;
  gradingCompany: string | null;
  previousGrade: string | null;
  newGrade: string | null;
  action: string | null;
}

/** One firm's price-target post (`/stable/price-target-news`) — the per-analyst
 * target, keyed by the issuing firm. Used to give each grade its OWN target
 * instead of repeating the ticker's consensus across every firm. */
export interface FmpPriceTargetRow {
  date: string;
  firm: string | null;
  priceTarget: number | null;
  /** The post's headline — often states the target it replaced ("lowered to
   * $80 from $93 at Barclays"), which no structured field carries. */
  title: string | null;
}

/** One share split (`/stable/splits`). `ratio` is new shares per old share:
 * 5 for a 5-for-1 split, 0.1 for a 1-for-10 reverse split. */
export interface FmpSplitRow {
  date: string;
  ratio: number;
}

/** One rating-news headline (`/stable/grades-news`). Carries no structured
 * price target, but the headline usually states it ("price target raised to
 * $350 from $340 at TD Cowen") for firms `price-target-news` never covers. */
export interface FmpGradeNewsRow {
  date: string;
  /** FMP's firm attribution — NOT reliable on its own (BRZE "Citizens"
   * headlines are tagged "Citigroup"); callers must verify it against `title`. */
  firm: string | null;
  title: string;
}

/** A macro/economic-calendar release (past or scheduled). */
export interface FmpEconEventRow {
  date: string;
  country: string | null;
  event: string | null;
  currency: string | null;
  previous: number | null;
  estimate: number | null;
  actual: number | null;
  impact: string | null;
  unit: string | null;
}

/** One earnings-call transcript (`/stable/earning-call-transcript`). */
export interface FmpTranscriptRow {
  symbol: string;
  /** Fiscal quarter number, 1-4 (FMP's `period`/`quarter` field). */
  quarter: number | null;
  year: number | null;
  /** Call date (YYYY-MM-DD, sometimes with a time component). */
  date: string | null;
  /** Full transcript text — operator intro, prepared remarks and Q&A. */
  content: string;
}

/** Available (year, quarter) a transcript exists for (`/stable/earning-call-transcript-dates`). */
export interface FmpTranscriptDate {
  quarter: number | null;
  year: number | null;
  date: string | null;
}

/**
 * Per-ticker institutional (13F) ownership summary for one fiscal quarter
 * (`/stable/institutional-ownership/symbol-positions-summary`). This is the
 * ticker-indexed rollup SEC 13F (CUSIP-keyed) cannot give directly.
 */
export interface FmpInstitutionalOwnershipRow {
  symbol: string;
  year: number | null;
  quarter: number | null;
  /** Number of institutions holding the stock this quarter. */
  investorsHolding: number | null;
  /** Prior-quarter holder count. */
  lastInvestorsHolding: number | null;
  /** Net change in holder count QoQ (holders added − removed). */
  investorsHoldingChange: number | null;
  /** Total 13F shares held. */
  numberOf13Fshares: number | null;
  lastNumberOf13Fshares: number | null;
  /** Net change in shares held QoQ. */
  numberOf13FsharesChange: number | null;
  /** Total dollars invested across all 13F holders. */
  totalInvested: number | null;
  /** Percent of shares outstanding held by institutions (0-100). */
  ownershipPercent: number | null;
  /** Aggregate put/call ratio across holders (sentiment tilt). */
  putCallRatio: number | null;
}

/** One row of `/stable/quote` — only the fields callers read. */
export interface FmpQuote {
  symbol: string;
  price: number;
  changePercentage: number;
  previousClose: number | null;
  /** Unix seconds of the last print. */
  timestamp: number;
}

/** A full `/stable/quote` (or `/stable/batch-quote`) row, for the live quote cache. */
export interface FmpFullQuote {
  symbol: string;
  price: number | null;
  change: number | null;
  changePercentage: number | null;
  previousClose: number | null;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  /** Unix seconds of the last print. */
  timestamp: number | null;
}

@Injectable()
export class FmpService {
  private readonly logger = new Logger(FmpService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  // Request pacing. A large per-ticker batch (financials over ~150 names = ~300
  // calls) bursts FMP hard enough that it silently returns empty 200s for a
  // rotating subset — no 429, no error, just missing data that never converges
  // across re-runs. A minimum gap between requests spreads the burst so every
  // call gets a real response. `nextSlot` reserves evenly-spaced send times even
  // when callers fire concurrently.
  private readonly minIntervalMs: number;
  private nextSlot = 0;
  // Short-TTL memo for `/stable/earnings` — both getQuarterlyEstimates and
  // getEpsHistory derive from it and are called back-to-back per ticker, so
  // without this the same endpoint is fetched twice per ticker across the whole
  // universe. TTL only needs to bridge those two calls; purged on growth.
  private readonly earningsCache = new Map<
    string,
    { at: number; rows: FmpEarningsSurpriseRow[] }
  >();
  private static readonly EARNINGS_CACHE_TTL_MS = 60_000;
  // Set once `/stable/batch-quote` answers with a plan/auth refusal, so every
  // later getQuotes() goes straight to per-symbol calls instead of paying a
  // doomed request each refresh. Process-lifetime: a plan upgrade needs a restart.
  private batchQuoteUnsupported = false;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get("FMP_API_KEY", "");
    this.baseUrl = this.config
      .get("FMP_API_BASE_URL", DEFAULT_BASE_URL)
      .replace(/\/$/, "");
    this.minIntervalMs = Number(this.config.get("FMP_MIN_INTERVAL_MS", "50"));
    if (!this.apiKey) {
      this.logger.warn(
        "FMP_API_KEY not set — FMP-backed features stay disabled (Polygon-only). Set the key and the relevant *_SOURCE=fmp to enable.",
      );
    }
  }

  /** True once a key is present — callers should skip work when disabled. */
  get enabled(): boolean {
    return !!this.apiKey;
  }

  /** False once batch-quote has been refused by the plan (see getQuotes). */
  get batchQuoteSupported(): boolean {
    return !this.batchQuoteUnsupported;
  }

  /** Reserve the next evenly-spaced send slot, then wait until it arrives. Safe
   * under concurrency: each caller claims a distinct slot `minIntervalMs` apart. */
  private async pace(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    const wait = slot - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  private async get(path: string, opts?: FetchJsonOptions): Promise<unknown[]> {
    await this.pace();
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetchJson<unknown>(
      `${this.baseUrl}/${path}${sep}apikey=${this.apiKey}`,
      opts,
    );
    return Array.isArray(res) ? res : [];
  }

  /**
   * Bulk earnings calendar for a date window (`/stable/earnings-calendar`) —
   * ONE request covering every company, carrying the analyst EPS/revenue
   * estimates Polygon lacks. `date` is the report date.
   */
  async getEarningsCalendar(
    from: string,
    to: string,
  ): Promise<FmpEarningRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(`earnings-calendar?from=${from}&to=${to}`);
    return rows.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        date: String(o.date ?? ""),
        symbol: String(o.symbol ?? ""),
        epsEstimated: num(o.epsEstimated),
        revenueEstimated: num(o.revenueEstimated),
        epsActual: num(o.epsActual),
        revenueActual: num(o.revenueActual),
      };
    });
  }

  /**
   * Per-ticker stock news (`/stable/news/stock`). `site` is the publishing
   * outlet; some responses also carry a `sentiment` label which we pass through.
   */
  /**
   * BULK latest stock news (`/stable/news/stock-latest`) — every symbol at once,
   * newest first, instead of one call per ticker. 250 rows per page covers ~217
   * distinct symbols, so a couple of pages reach far more tickers than a
   * per-ticker sweep ever did, for a fraction of the calls.
   *
   * Pages are fetched in order and stop early once a page comes back short (the
   * end of the feed) so we never spend calls on empty pages.
   */
  async getLatestStockNews(pages = 2, limit = 250): Promise<FmpNewsRow[]> {
    if (!this.apiKey) return [];
    const out: FmpNewsRow[] = [];
    for (let page = 0; page < pages; page++) {
      const rows = (await this.get(
        `news/stock-latest?page=${page}&limit=${limit}`,
      ).catch(() => [])) as Record<string, unknown>[];
      for (const r of rows) {
        out.push({
          symbol: (r.symbol as string) ?? null,
          publishedDate: String(r.publishedDate ?? r.date ?? ""),
          title: String(r.title ?? ""),
          text: (r.text as string) ?? null,
          site: (r.site as string) ?? (r.publisher as string) ?? null,
          url: String(r.url ?? ""),
          image: (r.image as string) ?? null,
          sentiment: (r.sentiment as string) ?? null,
        });
      }
      if (rows.length < limit) break; // short page = end of feed
    }
    return out;
  }

  async getStockNews(
    symbol: string,
    from: string,
    to: string,
  ): Promise<FmpNewsRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(
      `news/stock?symbols=${encodeURIComponent(symbol)}&from=${from}&to=${to}&limit=20`,
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      symbol: (r.symbol as string) ?? symbol,
      publishedDate: String(r.publishedDate ?? r.date ?? ""),
      title: String(r.title ?? ""),
      text: (r.text as string) ?? null,
      site: (r.site as string) ?? (r.publisher as string) ?? null,
      url: String(r.url ?? ""),
      image: (r.image as string) ?? null,
      sentiment: (r.sentiment as string) ?? null,
    }));
  }

  /**
   * Company profile (`/stable/profile`) — used for FMP's GICS `sector`/
   * `industry` classification (cleaner than Polygon's free-text SIC, e.g. FMP
   * codes IREN "Technology" where Polygon's SIC lands on "Finance Services")
   * and for `description` (FMP's is the fuller business-operations writeup;
   * Polygon's ticker-details `description` is a shorter, more generic blurb —
   * see PolygonCompanyProfileAdapter). Best-effort: `retries:0` so a momentary
   * 429 degrades fast to the Polygon-only fields; null when the key is absent
   * or FMP has no row. The caller whitelists FMP's sector string against the
   * app's canonical set (see resolveSector/normalizeFmpSector) so an
   * unrecognised label is ignored.
   */
  async getCompanyProfile(
    ticker: string,
  ): Promise<FmpCompanyProfileRow | null> {
    if (!this.apiKey) return null;
    const rows = await this.get(
      `profile?symbol=${encodeURIComponent(ticker)}`,
      { retries: 0 },
    );
    if (rows.length === 0) return null;
    const o = rows[0] as Record<string, unknown>;
    const str = (v: unknown): string | null =>
      v != null && String(v).trim() !== "" ? String(v).trim() : null;
    return {
      symbol: String(o.symbol ?? ticker),
      companyName: str(o.companyName),
      sector: str(o.sector),
      industry: str(o.industry),
      description: str(o.description),
    };
  }

  /**
   * Analyst grades consensus (`/stable/grades-consensus`) — Buy/Hold/Sell vote
   * tallies + a label for one ticker. `retries:0` so a momentary 429 drops the
   * ticker fast instead of stalling the whole board.
   */
  async getAnalystConsensus(ticker: string): Promise<FmpConsensusRow | null> {
    if (!this.apiKey) return null;
    const rows = await this.get(
      `grades-consensus?symbol=${encodeURIComponent(ticker)}`,
      { retries: 0 },
    );
    if (rows.length === 0) return null;
    const o = rows[0] as Record<string, unknown>;
    return {
      symbol: String(o.symbol ?? ticker),
      strongBuy: num(o.strongBuy),
      buy: num(o.buy),
      hold: num(o.hold),
      sell: num(o.sell),
      strongSell: num(o.strongSell),
      consensus: o.consensus != null ? String(o.consensus) : null,
    };
  }

  /**
   * Latest quote for one symbol (`/stable/quote`). Covers indices (^GSPC,
   * ^VIX) and commodity futures (GCUSD, BZUSD) as well as equities. One symbol
   * per call; for many symbols use getQuotes() (batch-quote verified available
   * on the current plan 2026-09-28). Returns null on
   * a plan-restricted symbol, an empty answer or any error — never throws.
   */
  async getQuote(symbol: string): Promise<FmpQuote | null> {
    if (!this.enabled) return null;
    try {
      const [r] = (await this.get(`quote?symbol=${encodeURIComponent(symbol)}`)) as any[];
      const price = Number(r?.price);
      const pct = Number(r?.changePercentage);
      const ts = Number(r?.timestamp);
      if (!Number.isFinite(price) || !Number.isFinite(pct) || !Number.isFinite(ts)) return null;
      const prev = Number(r?.previousClose);
      return {
        symbol: String(r.symbol ?? symbol),
        price,
        changePercentage: pct,
        previousClose: Number.isFinite(prev) ? prev : null,
        timestamp: ts,
      };
    } catch (err) {
      this.logger.warn(`FMP quote ${symbol} failed: ${(err as Error)?.message ?? err}`);
      return null;
    }
  }

  /**
   * Full quotes for many symbols — the live quote cache's FMP source
   * (`LIVE_QUOTE_SOURCE=fmp`). One `/stable/batch-quote` call when the plan has it;
   * otherwise one `/stable/quote` per symbol through the shared pacer, so N
   * symbols cost N calls and ~N × FMP_MIN_INTERVAL_MS of wall time. Symbols FMP
   * cannot price are simply absent from the result. Throws only when the batch
   * call fails for a reason other than the plan refusing it.
   */
  async getQuotes(symbols: string[]): Promise<FmpFullQuote[]> {
    if (!this.enabled || symbols.length === 0) return [];
    const started = Date.now();

    if (!this.batchQuoteUnsupported) {
      try {
        const rows = await this.get(
          `batch-quote?symbols=${encodeURIComponent(symbols.join(","))}`,
        );
        const quotes = rows
          .map(toFullQuote)
          .filter((q): q is FmpFullQuote => !!q);
        this.logLiveFetch("batch-quote", symbols, quotes, started);
        return quotes;
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        // 401/402/403 = endpoint not on this plan. Anything else (timeout, 5xx)
        // is transient and must not permanently downgrade to per-symbol calls.
        if (!/-> 40[123]:/.test(msg)) throw err;
        this.batchQuoteUnsupported = true;
        this.logger.warn(
          "FMP batch-quote not available on this plan — falling back to one /quote call per symbol.",
        );
      }
    }

    const rows = await Promise.all(
      symbols.map((s) =>
        this.get(`quote?symbol=${encodeURIComponent(s)}`)
          .then(([r]) => toFullQuote(r))
          .catch((err) => {
            this.logger.warn(
              `FMP quote ${s} failed: ${(err as Error)?.message ?? err}`,
            );
            return null;
          }),
      ),
    );
    const quotes = rows.filter((q): q is FmpFullQuote => !!q);
    this.logLiveFetch("per-symbol quote", symbols, quotes, started);
    return quotes;
  }

  /**
   * One line per live-quote fetch, so the log shows plainly that live prices
   * are coming from FMP: mode, how many priced, time taken, a sample, and
   * which symbols FMP could not price (those go to LIVE_QUOTE_FALLBACK_SOURCE).
   */
  private logLiveFetch(
    mode: string,
    requested: string[],
    quotes: FmpFullQuote[],
    started: number,
  ) {
    const priced = new Set(quotes.map((q) => q.symbol));
    const missing = requested.filter((s) => !priced.has(s.toUpperCase()));
    const sample = quotes
      .slice(0, 3)
      .map((q) => `${q.symbol}=${q.price}`)
      .join(" ");
    const line =
      `LIVE DATA from FMP (${mode}): ${quotes.length}/${requested.length} ` +
      `priced in ${Date.now() - started}ms [${sample}${quotes.length > 3 ? " …" : ""}]` +
      (missing.length
        ? ` — not priced by FMP: ${missing.slice(0, 10).join(",")}${missing.length > 10 ? " …" : ""}`
        : "");
    if (missing.length) this.logger.warn(line);
    else this.logger.log(line);
  }

  /** Sector performance snapshot (`/stable/sector-performance-snapshot`). */
  async getSectorPerformance(): Promise<FmpSectorPerformanceRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(`sector-performance-snapshot`);
    return rows.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        sector: String(o.sector ?? ""),
        changesPercentage: (o.averageChange ?? o.changesPercentage ?? null) as
          string | number | null,
      };
    });
  }

  /**
   * Forward annual analyst estimates (`/stable/analyst-estimates`) — avg
   * EPS/revenue per fiscal year, the source for the `*YYYY` forward rows.
   */
  async getForwardAnnualEstimates(
    ticker: string,
  ): Promise<FmpAnalystEstimateRow[]> {
    if (!this.apiKey) return [];
    // limit=40: enough annual rows that the forward years (current FY onward)
    // are always in the response regardless of FMP's sort order. limit=8 could
    // return only old years for companies with long estimate histories, which
    // the `>= thisYear` filter in the adapter then drops to empty.
    const rows = await this.get(
      `analyst-estimates?symbol=${encodeURIComponent(ticker)}&period=annual&limit=40`,
    );
    return rows.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        date: String(o.date ?? ""),
        symbol: String(o.symbol ?? ticker),
        estimatedEpsAvg: num(o.epsAvg ?? o.estimatedEpsAvg),
        estimatedRevenueAvg: num(o.revenueAvg ?? o.estimatedRevenueAvg),
      };
    });
  }

  /**
   * One financial statement series (`/stable/income-statement`,
   * `/stable/balance-sheet-statement`, `/stable/cash-flow-statement`), newest
   * first. Unlike the other getters this THROWS when FMP is disabled: it backs
   * a fallback chain, and an empty result would read as "the vendor has no
   * statements" — masking the real primary failure behind a benign empty.
   */
  async getFinancialStatement(
    kind: FmpStatementKind,
    ticker: string,
    period: "quarter" | "annual",
    limit: number,
  ): Promise<FmpStatementRow[]> {
    if (!this.apiKey) {
      throw new Error(
        "FMP_API_KEY not set — FMP financial statements unavailable",
      );
    }
    const rows = await this.get(
      `${kind}?symbol=${encodeURIComponent(ticker)}&period=${period}&limit=${limit}`,
    );
    return rows.flatMap((r) => {
      const o = r as Record<string, unknown>;
      if (!o || typeof o.date !== "string" || !o.date) return [];
      const values: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "number") values[k] = num(v);
      }
      return [
        {
          date: o.date,
          fiscalYear:
            typeof o.fiscalYear === "string" || typeof o.fiscalYear === "number"
              ? String(o.fiscalYear)
              : null,
          period: typeof o.period === "string" ? o.period : null,
          filingDate: typeof o.filingDate === "string" ? o.filingDate : null,
          reportedCurrency:
            typeof o.reportedCurrency === "string" ? o.reportedCurrency : null,
          values,
        },
      ];
    });
  }

  /**
   * Per-ticker earnings history (`/stable/earnings`) — actual + estimated EPS
   * across all reported quarters, the source for the quarterly %surp column.
   */
  async getEarningsSurprises(
    ticker: string,
  ): Promise<FmpEarningsSurpriseRow[]> {
    if (!this.apiKey) return [];
    const key = ticker.toUpperCase();
    const now = Date.now();
    const cached = this.earningsCache.get(key);
    if (cached && now - cached.at < FmpService.EARNINGS_CACHE_TTL_MS) {
      return cached.rows;
    }
    const rows = await this.get(
      `earnings?symbol=${encodeURIComponent(ticker)}&limit=40`,
    );
    const mapped = rows.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        date: String(o.date ?? ""),
        symbol: String(o.symbol ?? ticker),
        actualEarningResult: num(o.epsActual ?? o.actualEarningResult),
        estimatedEarning: num(o.epsEstimated ?? o.estimatedEarning),
      };
    });
    // Bound memory across a full-universe sweep: purge expired entries on growth.
    if (this.earningsCache.size > 256) {
      for (const [k, v] of this.earningsCache) {
        if (now - v.at >= FmpService.EARNINGS_CACHE_TTL_MS) {
          this.earningsCache.delete(k);
        }
      }
    }
    this.earningsCache.set(key, { at: now, rows: mapped });
    return mapped;
  }

  /**
   * Analyst price-target consensus (`/stable/price-target-consensus`) — the
   * high/low/average/median 12-month target across covering firms. `retries:0`
   * so a momentary miss drops the ticker fast instead of stalling the sweep.
   */
  async getPriceTargetConsensus(
    ticker: string,
  ): Promise<FmpPriceTargetConsensusRow | null> {
    if (!this.apiKey) return null;
    const rows = await this.get(
      `price-target-consensus?symbol=${encodeURIComponent(ticker)}`,
      { retries: 0 },
    );
    if (rows.length === 0) return null;
    const o = rows[0] as Record<string, unknown>;
    return {
      targetHigh: num(o.targetHigh),
      targetLow: num(o.targetLow),
      targetConsensus: num(o.targetConsensus),
      targetMedian: num(o.targetMedian),
    };
  }

  /**
   * Rolling average price target (`/stable/price-target-summary`) — mean target
   * over the last month/quarter/year, so the UI can show whether targets trend
   * up or down.
   */
  async getPriceTargetSummary(
    ticker: string,
  ): Promise<FmpPriceTargetSummaryRow | null> {
    if (!this.apiKey) return null;
    const rows = await this.get(
      `price-target-summary?symbol=${encodeURIComponent(ticker)}`,
      { retries: 0 },
    );
    if (rows.length === 0) return null;
    const o = rows[0] as Record<string, unknown>;
    return {
      lastMonthCount: num(o.lastMonthCount),
      lastMonthAvg: num(o.lastMonthAvgPriceTarget),
      lastQuarterCount: num(o.lastQuarterCount),
      lastQuarterAvg: num(o.lastQuarterAvgPriceTarget),
      lastYearCount: num(o.lastYearCount),
      lastYearAvg: num(o.lastYearAvgPriceTarget),
    };
  }

  /**
   * Per-firm rating changes (`/stable/grades`) — the analyst-action event feed
   * Polygon has no equivalent for: which firm, from→to grade, and the action
   * (upgrade/downgrade/initiate/maintain). Newest first; `limit` bounds the pull.
   */
  async getGrades(ticker: string, limit = 10): Promise<FmpGradeRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(
      `grades?symbol=${encodeURIComponent(ticker)}&limit=${limit}`,
      { retries: 0 },
    );
    // FMP's `grades` endpoint IGNORES the limit param and returns the full
    // history (1000s of rows) newest-first — slice here or a batch write blows
    // past Firestore's 11.5MB limit.
    return rows.slice(0, limit).map((r) => {
      const o = r as Record<string, unknown>;
      return {
        date: String(o.date ?? ""),
        gradingCompany: o.gradingCompany != null ? String(o.gradingCompany) : null,
        previousGrade: o.previousGrade != null ? String(o.previousGrade) : null,
        newGrade: o.newGrade != null ? String(o.newGrade) : null,
        action: o.action != null ? String(o.action) : null,
      };
    });
  }

  /**
   * Per-firm price targets (`/stable/price-target-news`) — each covering firm's
   * OWN 12-month target + the date it was posted. Joined to grades by firm so
   * the "Per-firm analyst actions" table shows real per-firm PTs instead of the
   * ticker's single consensus repeated on every row.
   */
  async getPriceTargets(
    ticker: string,
    // 100 is FMP's own server-side ceiling for this endpoint — asking for 200
    // still returns 100. We were asking for 60 and throwing away the rest: on a
    // heavily-covered name like GOOG the first 60 posts carry 28 distinct firms
    // while the full 100 carry 37, so nine firms' targets were being dropped
    // before the join could ever see them.
    limit = 100,
  ): Promise<FmpPriceTargetRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(
      `price-target-news?symbol=${encodeURIComponent(ticker)}&limit=${limit}`,
      { retries: 0 },
    ).catch(() => [] as unknown[]);
    return rows
      .map((r) => {
        const o = r as Record<string, unknown>;
        return {
          date: String(o.publishedDate ?? o.date ?? "").slice(0, 10),
          firm: o.analystCompany != null ? String(o.analystCompany) : null,
          priceTarget: num(o.priceTarget ?? o.adjPriceTarget),
          title: o.newsTitle != null ? String(o.newsTitle) : null,
        };
      })
      .filter((r) => r.firm && r.priceTarget != null);
  }

  /**
   * Rating-news headlines (`/stable/grades-news`), newest first. A second
   * per-firm target source: `price-target-news` omits whole firms (TD Cowen,
   * Citi, …) or lags months behind, while their PT changes still appear here as
   * headlines. Same 100-row server ceiling as `price-target-news`.
   */
  async getGradeNews(ticker: string, limit = 100): Promise<FmpGradeNewsRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(
      `grades-news?symbol=${encodeURIComponent(ticker)}&limit=${limit}`,
      { retries: 0 },
    ).catch(() => [] as unknown[]);
    return rows
      .map((r) => {
        const o = r as Record<string, unknown>;
        return {
          date: String(o.publishedDate ?? "").slice(0, 10),
          firm: o.gradingCompany != null ? String(o.gradingCompany) : null,
          title: o.newsTitle != null ? String(o.newsTitle) : "",
        };
      })
      .filter((r) => r.date && r.title);
  }

  /**
   * Share-split history (`/stable/splits`). Analyst targets are quoted on the
   * share basis of the day they were posted, so a target from before a split
   * must be rescaled before it can be compared with one from after.
   */
  async getSplits(ticker: string): Promise<FmpSplitRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(
      `splits?symbol=${encodeURIComponent(ticker)}`,
      { retries: 0 },
    ).catch(() => [] as unknown[]);
    return rows
      .map((r) => {
        const o = r as Record<string, unknown>;
        const numerator = num(o.numerator);
        const denominator = num(o.denominator);
        return {
          date: String(o.date ?? "").slice(0, 10),
          ratio: numerator && denominator ? numerator / denominator : NaN,
        };
      })
      .filter((r) => r.date && Number.isFinite(r.ratio) && r.ratio > 0 && r.ratio !== 1);
  }

  /**
   * Economic calendar (`/stable/economic-calendar`) — scheduled + released macro
   * events (CPI, PPI, jobs, FOMC…) with date, estimate, previous and actual. This
   * is the forward release schedule FRED cannot provide (FRED has only past
   * observations). `date` carries a time; callers take the date part.
   */
  async getEconomicCalendar(
    from: string,
    to: string,
  ): Promise<FmpEconEventRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(`economic-calendar?from=${from}&to=${to}`);
    return rows.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        date: String(o.date ?? ""),
        country: o.country != null ? String(o.country) : null,
        event: o.event != null ? String(o.event) : null,
        currency: o.currency != null ? String(o.currency) : null,
        previous: num(o.previous),
        estimate: num(o.estimate),
        actual: num(o.actual),
        impact: o.impact != null ? String(o.impact) : null,
        unit: o.unit != null ? String(o.unit) : null,
      };
    });
  }

  /**
   * One earnings-call transcript for an explicit fiscal (year, quarter)
   * (`/stable/earning-call-transcript?symbol=&year=&quarter=`). Returns null
   * when FMP has no transcript for that exact period. `period` on the response
   * is the quarter (e.g. "Q2" or 2) — parsed to a number defensively.
   */
  async getEarningsTranscript(
    ticker: string,
    year: number,
    quarter: number,
  ): Promise<FmpTranscriptRow | null> {
    if (!this.apiKey) return null;
    const rows = await this.get(
      `earning-call-transcript?symbol=${encodeURIComponent(ticker)}&year=${year}&quarter=${quarter}`,
    );
    const o = rows[0] as Record<string, unknown> | undefined;
    const content = o?.content != null ? String(o.content) : "";
    if (!o || !content.trim()) return null;
    return {
      symbol: String(o.symbol ?? ticker),
      quarter: quarterNum(o.period ?? o.quarter) ?? quarter,
      year: num(o.year) ?? year,
      date: o.date != null ? String(o.date) : null,
      content,
    };
  }

  /**
   * The (year, quarter) periods FMP has a transcript for, newest first
   * (`/stable/earning-call-transcript-dates?symbol=`). Used to resolve the
   * latest call without guessing the calendar quarter. Parsed defensively:
   * FMP has returned both objects ({quarter,year,date}) and tuple arrays
   * ([quarter,year,date]) across versions.
   */
  async getTranscriptDates(ticker: string): Promise<FmpTranscriptDate[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(
      `earning-call-transcript-dates?symbol=${encodeURIComponent(ticker)}`,
    );
    const parsed = rows.map((r): FmpTranscriptDate => {
      if (Array.isArray(r)) {
        return { quarter: quarterNum(r[0]), year: num(r[1]), date: r[2] != null ? String(r[2]) : null };
      }
      const o = r as Record<string, unknown>;
      return {
        quarter: quarterNum(o.quarter ?? o.period),
        year: num(o.year ?? o.fiscalYear),
        date: o.date != null ? String(o.date) : null,
      };
    });
    return parsed
      .filter((d) => d.year != null && d.quarter != null)
      .sort((a, b) => (b.year! - a.year!) || (b.quarter! - a.quarter!));
  }

  /**
   * The most recent earnings-call transcript for a ticker. Resolves the latest
   * (year, quarter) from `getTranscriptDates` when available; if that endpoint
   * yields nothing, falls back to probing the last few calendar quarters so a
   * transcript is still found. Returns null when none exists / FMP is off.
   */
  async getLatestEarningsTranscript(
    ticker: string,
  ): Promise<FmpTranscriptRow | null> {
    if (!this.apiKey) return null;

    const tryFetch = (year: number, quarter: number) =>
      this.getEarningsTranscript(ticker, year, quarter).catch(() => null);

    const dates = await this.getTranscriptDates(ticker).catch(() => []);
    for (const d of dates.slice(0, 4)) {
      const tx = await tryFetch(d.year!, d.quarter!);
      if (tx) return tx;
    }

    // Fallback: dates endpoint gave nothing — probe recent calendar quarters
    // (most recent first). Earnings for a quarter are reported the following
    // one, so the current calendar quarter is usually not yet available.
    for (const { year, quarter } of recentQuarters(6)) {
      const tx = await tryFetch(year, quarter);
      if (tx) return tx;
    }
    return null;
  }

  /**
   * Per-ticker institutional-ownership summary for an explicit (year, quarter)
   * (`/stable/institutional-ownership/symbol-positions-summary`). Returns null
   * when FMP has no 13F rollup for that ticker/period.
   */
  async getInstitutionalOwnership(
    ticker: string,
    year: number,
    quarter: number,
  ): Promise<FmpInstitutionalOwnershipRow | null> {
    if (!this.apiKey) return null;
    const rows = await this.get(
      `institutional-ownership/symbol-positions-summary?symbol=${encodeURIComponent(ticker)}&year=${year}&quarter=${quarter}`,
    );
    const o = rows[0] as Record<string, unknown> | undefined;
    if (!o) return null;
    const investorsHolding = num(o.investorsHolding);
    if (investorsHolding == null) return null; // no real rollup for this period
    return {
      symbol: String(o.symbol ?? ticker),
      year: num(o.year) ?? year,
      quarter: quarterNum(o.quarter ?? o.period) ?? quarter,
      investorsHolding,
      lastInvestorsHolding: num(o.lastInvestorsHolding),
      investorsHoldingChange: num(o.investorsHoldingChange),
      numberOf13Fshares: num(o.numberOf13Fshares),
      lastNumberOf13Fshares: num(o.lastNumberOf13Fshares),
      numberOf13FsharesChange: num(o.numberOf13FsharesChange),
      totalInvested: num(o.totalInvested),
      ownershipPercent: num(o.ownershipPercent),
      putCallRatio: num(o.putCallRatio),
    };
  }

  /**
   * The most-recent institutional-ownership summary for a ticker. 13F rollups
   * lag the quarter end by ~45 days, so the current calendar quarter is usually
   * not yet published — probe the last few quarters, newest first. Returns null
   * (and the resolved period on success) so a caller can reuse the period for a
   * batch of tickers instead of re-probing each one.
   */
  async getLatestInstitutionalOwnership(
    ticker: string,
  ): Promise<FmpInstitutionalOwnershipRow | null> {
    if (!this.apiKey) return null;
    for (const { year, quarter } of recentQuarters(5)) {
      const row = await this.getInstitutionalOwnership(ticker, year, quarter).catch(
        () => null,
      );
      if (row) return row;
    }
    return null;
  }

  /**
   * Normalized income statements matching Polygon's getIncomeStatements shape.
   * Period can be "annual" or "quarterly" (defaults to "annual").
   */
  async getIncomeStatements(
    ticker: string,
    timeframe = "annual",
    limit = 2,
  ): Promise<
    Array<{
      fiscalYear: string | null;
      fiscalPeriod: string | null;
      endDate: string | null;
      revenue: number | null;
      costOfRevenue: number | null;
      grossProfit: number | null;
      netIncome: number | null;
      operatingIncome: number | null;
      dilutedEps: number | null;
    }>
  > {
    if (!this.apiKey) return [];
    const period = timeframe === "annual" ? "annual" : "quarter";
    const rows = (await this.get(
      `income-statement?symbol=${encodeURIComponent(ticker)}&period=${period}&limit=${limit}`,
    ).catch(() => [])) as FmpIncomeStatementRow[];

    return (Array.isArray(rows) ? rows : []).map((r) => ({
      fiscalYear: r.fiscalYear ? String(r.fiscalYear) : null,
      fiscalPeriod: r.period ?? null,
      endDate: r.date ?? null,
      revenue: num(r.revenue),
      costOfRevenue: num(r.costOfRevenue),
      grossProfit: num(r.grossProfit),
      netIncome: num(r.netIncome),
      operatingIncome: num(r.operatingIncome),
      dilutedEps: num(r.epsDiluted ?? r.eps),
    }));
  }

  /** Raw balance sheet rows from FMP. */
  async getBalanceSheetStatements(
    ticker: string,
    timeframe = "annual",
    limit = 2,
  ): Promise<FmpBalanceSheetRow[]> {
    if (!this.apiKey) return [];
    const period = timeframe === "annual" ? "annual" : "quarter";
    const res = await this.get(
      `balance-sheet-statement?symbol=${encodeURIComponent(ticker)}&period=${period}&limit=${limit}`,
    ).catch(() => []);
    return Array.isArray(res) ? (res as FmpBalanceSheetRow[]) : [];
  }

  /** Raw cash flow statement rows from FMP. */
  async getCashFlowStatements(
    ticker: string,
    timeframe = "annual",
    limit = 2,
  ): Promise<FmpCashFlowRow[]> {
    if (!this.apiKey) return [];
    const period = timeframe === "annual" ? "annual" : "quarter";
    const res = await this.get(
      `cash-flow-statement?symbol=${encodeURIComponent(ticker)}&period=${period}&limit=${limit}`,
    ).catch(() => []);
    return Array.isArray(res) ? (res as FmpCashFlowRow[]) : [];
  }

  /**
   * All three financial statements for one ticker, merged into the canonical
   * PolygonFinancialRow structure used across MarketCatalyst (financials.job,
   * ondemand.service, etc.).
   */
  async getFinancialStatements(
    ticker: string,
    timeframe = "quarterly",
    limit = 10,
  ): Promise<
    Array<{
      fiscalYear: string | null;
      fiscalPeriod: string | null;
      endDate: string | null;
      filingDate: string | null;
      income: Record<string, number | null>;
      balanceSheet: Record<string, number | null>;
      cashFlow: Record<string, number | null>;
    }>
  > {
    if (!this.apiKey) return [];
    const period = timeframe === "annual" ? "annual" : "quarter";
    const [income, bs, cf] = await Promise.all([
      this.get(
        `income-statement?symbol=${encodeURIComponent(ticker)}&period=${period}&limit=${limit}`,
      ).catch(() => []),
      this.get(
        `balance-sheet-statement?symbol=${encodeURIComponent(ticker)}&period=${period}&limit=${limit}`,
      ).catch(() => []),
      this.get(
        `cash-flow-statement?symbol=${encodeURIComponent(ticker)}&period=${period}&limit=${limit}`,
      ).catch(() => []),
    ]);

    const bsByDate = new Map<string, FmpBalanceSheetRow>(
      (Array.isArray(bs) ? (bs as FmpBalanceSheetRow[]) : [])
        .filter((r) => r?.date)
        .map((r) => [r.date, r]),
    );
    const cfByDate = new Map<string, FmpCashFlowRow>(
      (Array.isArray(cf) ? (cf as FmpCashFlowRow[]) : [])
        .filter((r) => r?.date)
        .map((r) => [r.date, r]),
    );

    return (Array.isArray(income) ? (income as FmpIncomeStatementRow[]) : []).map(
      (i) => {
        const b: Partial<FmpBalanceSheetRow> = bsByDate.get(i.date) ?? {};
        const c: Partial<FmpCashFlowRow> = cfByDate.get(i.date) ?? {};
        return {
          fiscalYear: i.fiscalYear ? String(i.fiscalYear) : null,
          fiscalPeriod: i.period ?? null,
          endDate: i.date ?? null,
          filingDate:
            i.filingDate ??
            (i.acceptedDate ? String(i.acceptedDate).slice(0, 10) : null),
          income: {
            revenues: num(i.revenue),
            cost_of_revenue: num(i.costOfRevenue),
            gross_profit: num(i.grossProfit),
            operating_income_loss: num(i.operatingIncome),
            net_income_loss: num(i.netIncome),
            diluted_earnings_per_share: num(i.epsDiluted ?? i.eps),
            basic_earnings_per_share: num(i.eps),
            operating_expenses: num(i.operatingExpenses),
            research_and_development: num(i.researchAndDevelopmentExpenses),
            selling_general_and_administrative_expenses: num(
              i.sellingGeneralAndAdministrativeExpenses,
            ),
            income_tax_expense_benefit: num(i.incomeTaxExpense),
            diluted_average_shares: num(
              i.weightedAverageShsOutDil ?? i.weightedAverageShsOut,
            ),
          },
          balanceSheet: {
            assets: num(b.totalAssets),
            current_assets: num(b.totalCurrentAssets),
            liabilities: num(b.totalLiabilities),
            current_liabilities: num(b.totalCurrentLiabilities),
            equity: num(b.totalStockholdersEquity ?? b.totalEquity),
            inventory: num(b.inventory),
            long_term_debt: num(b.longTermDebt),
          },
          cashFlow: {
            net_cash_flow: num(c.netChangeInCash),
            net_cash_flow_from_operating_activities: num(
              c.operatingCashFlow ?? c.netCashProvidedByOperatingActivities,
            ),
            net_cash_flow_from_investing_activities: num(
              c.netCashProvidedByInvestingActivities,
            ),
            net_cash_flow_from_financing_activities: num(
              c.netCashProvidedByFinancingActivities,
            ),
          },
        };
      },
    );
  }

  /**
   * TTM EPS approximated by summing the 4 most recent quarters of diluted EPS from FMP.
   */
  async getTtmEps(ticker: string): Promise<number | null> {
    if (!this.apiKey) return null;
    const inc = (await this.get(
      `income-statement?symbol=${encodeURIComponent(ticker)}&period=quarter&limit=4`,
    ).catch(() => [])) as FmpIncomeStatementRow[];
    if (!Array.isArray(inc) || inc.length < 4) return null;
    let sum = 0;
    for (const r of inc.slice(0, 4)) {
      const val = num(r?.epsDiluted ?? r?.eps);
      if (val == null) return null;
      sum += val;
    }
    return Math.round(sum * 100) / 100;
  }
}

/** Parses FMP's quarter field ("Q2", "2", 2) into a 1-4 number, else null. */
function quarterNum(v: unknown): number | null {
  if (typeof v === "number") return v >= 1 && v <= 4 ? v : null;
  if (typeof v === "string") {
    const m = v.match(/[1-4]/);
    return m ? Number(m[0]) : null;
  }
  return null;
}

/** The last `count` calendar quarters, most recent first, from a fixed clock. */
function recentQuarters(count: number): Array<{ year: number; quarter: number }> {
  const now = new Date();
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3) + 1; // 1-4
  const out: Array<{ year: number; quarter: number }> = [];
  for (let i = 0; i < count; i++) {
    out.push({ year, quarter });
    quarter -= 1;
    if (quarter < 1) { quarter = 4; year -= 1; }
  }
  return out;
}
