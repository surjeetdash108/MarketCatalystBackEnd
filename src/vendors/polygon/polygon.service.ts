import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchJson } from "../../common/http.util";
import { finiteOrNull, nonNegIntOrNull } from "../../common/validate.util";

// Polygon rebranded to Massive (Oct 2025); api.polygon.io still resolves but is
// being phased out in favour of api.massive.com. Kept configurable so the host
// can be cut over via env once a key is confirmed working on the new one,
// without a redeploy of changed code.
const DEFAULT_BASE_URL = "https://api.polygon.io";

// Delay between pages of a paginated endpoint. 12.5s is the free Basic tier's
// 5-calls-per-minute budget; EVERY paid tier is unlimited, so on a paid key
// this should be 0 — it otherwise adds minutes per run to getAllTickers,
// getDividendsCalendar and getIpoCalendar for no reason.
const DEFAULT_PAGE_DELAY_MS = 12_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Financial-statement unit assertion. Polygon tags each statement node with a
 * `unit`: monetary nodes carry an ISO-4217 currency code ("USD", or "USD /
 * shares" for per-share figures), while non-monetary nodes use lowercase tokens
 * ("shares", "pure"). Every consumer here assumes raw USD dollars, so a node
 * whose LEADING unit token is a three-letter code OTHER than USD is a genuine
 * currency mismatch — return that code so the caller can warn and null the value
 * rather than silently storing a foreign-denominated number as if it were USD.
 * Everything else (absent/non-string unit, USD-based, "shares", "pure", ratios)
 * is accepted unchanged, so the normal USD path is untouched. Deliberately
 * conservative: only an explicit non-USD currency code trips it.
 */
function nonUsdCurrencyUnit(unit: unknown): string | null {
  if (typeof unit !== "string") return null;
  const lead = unit.trim().split(/[\s/]/)[0];
  return /^[A-Z]{3}$/.test(lead) && lead !== "USD" ? lead : null;
}

export interface PolygonAggBar {
  T: string;
  v: number;
  o: number;
  c: number;
  h: number;
  l: number;
  t: number;
  n?: number;
  /** Volume-weighted average price for the bar. Always present on aggs; used as
   *  the session VWAP source instead of the fabricated value the UI showed. */
  vw?: number;
}

/**
 * Oldest date the plan will serve. Probed 2026-07-21: a daily-aggs request
 * starting 2021-07-22 returned 200 while 2021-07-01 returned
 * `NOT_AUTHORIZED / "Your plan doesn't include this data timeframe"` — i.e. a
 * five-year rolling window. Requests that cross the edge fail as a whole rather
 * than being truncated, so callers must clamp `from` instead of asking for more
 * and taking what arrives.
 */
export const PLAN_HISTORY_YEARS = 5;

/** The earliest `from` date the plan accepts today, with a few days of slack so
 *  a job scheduled near midnight cannot drift over the edge mid-run. */
export function planHistoryFloor(now: Date = new Date()): string {
  const floor = new Date(now);
  floor.setUTCFullYear(floor.getUTCFullYear() - PLAN_HISTORY_YEARS);
  floor.setUTCDate(floor.getUTCDate() + 3);
  return floor.toISOString().slice(0, 10);
}

export interface PolygonTickerRef {
  ticker: string;
  name: string;
  market: string;
  locale: string;
  primary_exchange?: string;
  type?: string;
  active: boolean;
  currency_name?: string;
  cik?: string;
  composite_figi?: string;
  share_class_figi?: string;
  last_updated_utc?: string;
}

export interface PolygonOptionContract {
  ticker: string;
  underlying_ticker: string;
  contract_type: "call" | "put";
  strike_price: number;
  expiration_date: string;
  exercise_style?: string;
  shares_per_contract?: number;
}

export interface PolygonNewsInsight {
  ticker: string;
  sentiment: "positive" | "negative" | "neutral";
  sentiment_reasoning: string;
}

export interface PolygonNewsArticle {
  id: string;
  image_url?: string;
  publisher: {
    name: string;
  };
  title: string;
  author?: string;
  published_utc: string;
  article_url: string;
  tickers: string[];
  description?: string;
  keywords?: string[];
  insights?: PolygonNewsInsight[];
}

@Injectable()
export class PolygonService {
  private readonly logger = new Logger(PolygonService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pageDelayMs: number;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get("POLYGON_API_KEY", "");
    if (!this.apiKey) {
      this.logger.warn(
        "POLYGON_API_KEY not set — Polygon-backed jobs will fail.",
      );
    }

    this.baseUrl = this.config
      .get("POLYGON_API_BASE_URL", DEFAULT_BASE_URL)
      .replace(/\/$/, "");

    // Parsed defensively: a typo or a negative value must fall back to the safe
    // free-tier delay rather than silently hammering the API. Blank is treated
    // as unset too — `POLYGON_PAGE_DELAY_MS=` is a natural way to leave the var
    // empty, and Number('') is 0, which would disable the throttle entirely.
    const rawDelay = String(
      this.config.get("POLYGON_PAGE_DELAY_MS", ""),
    ).trim();
    const parsedDelay = rawDelay === "" ? NaN : Number(rawDelay);
    this.pageDelayMs =
      Number.isFinite(parsedDelay) && parsedDelay >= 0
        ? parsedDelay
        : DEFAULT_PAGE_DELAY_MS;

    this.logger.log(
      `Polygon client: ${this.baseUrl}, page delay ${this.pageDelayMs}ms`,
    );
  }

  /**
   * The configured inter-request delay, exposed so per-ticker loops in the sync
   * jobs throttle on the same knob as this service's own pagination. Previously
   * three jobs hardcoded 12_500 independently, so setting POLYGON_PAGE_DELAY_MS=0
   * on a paid plan left them sleeping ~12.5 minutes per run regardless.
   */
  get requestDelayMs(): number {
    return this.pageDelayMs;
  }

  async getGroupedDaily(date: string): Promise<PolygonAggBar[]> {
    const res = await fetchJson<{ results?: PolygonAggBar[] }>(
      `${this.baseUrl}/v2/aggs/grouped/locale/us/market/stocks/${date}?apiKey=${this.apiKey}`,
    );
    return res.results ?? [];
  }

  async getLatestGroupedDaily(
    candidateDates: Iterable<string>,
  ): Promise<{ date: string; bars: PolygonAggBar[] } | null> {
    for (const date of candidateDates) {
      const bars = await this.getGroupedDaily(date);
      if (bars.length > 0) {
        return { date, bars };
      }
      this.logger.log(
        `No grouped-daily data for ${date} (holiday/weekend) — trying prior day`,
      );
    }
    return null;
  }

  async getAggsRange(
    ticker: string,
    from: string,
    to: string,
    timespan = "day",
    multiplier = 1,
    limit = 5000,
  ): Promise<PolygonAggBar[]> {
    const res = await fetchJson<{ results?: PolygonAggBar[] }>(
      `${this.baseUrl}/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${from}/${to}` +
        `?adjusted=true&sort=asc&limit=${limit}&apiKey=${this.apiKey}`,
    );
    const results = res.results ?? [];
    // BUG-DATA-011 root cause + fix. `adjusted=true` makes Polygon return
    // SPLIT-ADJUSTED volume, which it emits as a FLOAT: the raw session volume
    // multiplied by the cumulative split factor (e.g. 18_569_371.05639 for a
    // non-integer ratio such as 3:2). Real session volume is a whole number of
    // shares, but every stored/served bar path reads `v`/`b.v` verbatim
    // (ohlcv_bars via the bars adapter, on-demand stock_bars via
    // fetchAndStore/refreshIncremental, intraday_bars via getIntradayBars), so
    // the fraction propagates into 52w / SMA / EMA / RVOL / avgVolume. Normalise
    // to whole shares HERE — the single vendor boundary all bar fetches flow
    // through. Prices stay split-adjusted; only volume is rounded. Callers that
    // read only OHLC (getDailyQuote, ipos/fear-greed/company-profile) are
    // unaffected because they never read `v`.
    for (const b of results) {
      // Volume: split-adjusted floats arrive here (BUG-DATA-011). `Math.round`
      // alone let `NaN` (Math.round(NaN)===NaN) and negatives pass straight
      // through into 52w/SMA/EMA/RVOL/avgVolume. `nonNegIntOrNull` rounds a
      // valid volume to whole shares and rejects NaN/negative. `PolygonAggBar.v`
      // is a non-null `number` that every downstream consumer reads
      // arithmetically, so an invalid value coerces to 0 rather than null — a
      // null would break sorts/Math.min on the bar arrays. (Follow-up: widen the
      // interface to `number | null` so "unknown volume" is distinguishable from
      // a true 0.)
      b.v = nonNegIntOrNull(b.v) ?? 0;
      // OHLC: strip non-finite values (NaN/±Infinity) so a corrupt bar cannot
      // poison downstream sums/EMAs (NaN propagates through every subsequent
      // calc). finiteOrNull keeps legitimate 0/negatives; strictNullChecks is
      // off so assigning null to these number fields is type-safe here.
      b.o = finiteOrNull(b.o);
      b.h = finiteOrNull(b.h);
      b.l = finiteOrNull(b.l);
      b.c = finiteOrNull(b.c);
    }
    return results;
  }

  /**
   * Intraday aggregate bars. Verified authorized on this plan (2026-07-21):
   * `/range/1/minute` returned 1553 bars and still resolves a year back — the
   * intraday timeframes were never plan-blocked, only unsynced.
   *
   * `limit` is raised well above the 5000 default because a multi-day 1-minute
   * pull exceeds it silently, and a truncated series plots as a chart that just
   * stops mid-window.
   */
  async getIntradayBars(
    ticker: string,
    multiplier: number,
    timespan: "minute" | "hour",
    from: string,
    to: string,
  ): Promise<PolygonAggBar[]> {
    return this.getAggsRange(ticker, from, to, timespan, multiplier, 50_000);
  }

  /**
   * The OFFICIAL 16:00 ET regular-session close for one ticker on one date, via
   * the daily open-close endpoint. `/v2/aggs` daily `c` is the last trade over
   * the FULL extended session (incl. after-hours), which skews classic pivots;
   * this endpoint's `close` is the official regular-session close. Only used to
   * correct the keyLevels.daily pivot basis — `afterHours`/`preMarket` are
   * deliberately ignored.
   *
   * Fail-safe by design: any error / 404 / missing field returns null so callers
   * fall back to the stored daily close (no new failure mode). Never throws.
   * `date` is YYYY-MM-DD.
   */
  async getOfficialClose(ticker: string, date: string): Promise<number | null> {
    try {
      const res = await fetchJson<{ close?: unknown }>(
        `${this.baseUrl}/v1/open-close/${ticker}/${date}` +
          `?adjusted=true&apiKey=${this.apiKey}`,
      );
      return finiteOrNull(res.close);
    } catch {
      return null;
    }
  }

  /**
   * Peer tickers. Polygon DOES have a peers product — earlier notes in this repo
   * recorded `peers` as "structurally null on this source", which was wrong: the
   * companies job simply never called this endpoint. Verified on the paid plan,
   * AAPL returns MSFT, AMZN, GOOGL, GOOG, NVDA.
   */
  async getRelatedCompanies(ticker: string): Promise<string[]> {
    const res = await fetchJson<{ results?: Array<{ ticker: string }> }>(
      `${this.baseUrl}/v1/related-companies/${ticker}?apiKey=${this.apiKey}`,
    );
    return (res.results ?? []).map((r) => r.ticker).filter(Boolean);
  }

  /**
   * Full dividend history for one ticker, newest first. Distinct from
   * getDividendsCalendar, which sweeps every ticker over a forward ex-date
   * window; this walks one ticker backwards to build the history chart and the
   * trailing-twelve-month figure the yield is derived from.
   */
  async getDividendHistory(
    ticker: string,
    limit = 200,
  ): Promise<
    Array<{
      exDividendDate: string | null;
      paymentDate: string | null;
      declarationDate: string | null;
      recordDate: string | null;
      // Nullable: Polygon can omit cash_amount on a row (e.g. a stock-only
      // distribution). Read null-safe below; consumers must `?? 0` in sums and
      // never store a fabricated 0 as the amount.
      cashAmount: number | null;
      dividendType: string | null;
      frequency: number | null;
    }>
  > {
    const res = await fetchJson<any>(
      `${this.baseUrl}/v3/reference/dividends?ticker=${ticker}` +
        `&order=desc&sort=ex_dividend_date&limit=${limit}&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []).map((d: any) => ({
      exDividendDate: d.ex_dividend_date ?? null,
      paymentDate: d.pay_date ?? null,
      declarationDate: d.declaration_date ?? null,
      recordDate: d.record_date ?? null,
      cashAmount: d.cash_amount ?? null,
      dividendType: d.dividend_type ?? null,
      frequency: d.frequency ?? null,
    }));
  }

  /** Split history for one ticker, newest first. */
  async getSplits(
    ticker: string,
    limit = 50,
  ): Promise<
    Array<{ executionDate: string; splitFrom: number; splitTo: number }>
  > {
    const res = await fetchJson<any>(
      `${this.baseUrl}/v3/reference/splits?ticker=${ticker}` +
        `&order=desc&sort=execution_date&limit=${limit}&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []).map((s: any) => ({
      executionDate: s.execution_date,
      splitFrom: s.split_from,
      splitTo: s.split_to,
    }));
  }

  /**
   * Every split executing in a date window, across all tickers, in one call.
   * Used to detect the reverse-split artifact in close-to-close %change: when a
   * split takes effect between the two comparison days, the prior close is
   * pre-split and today's is post-split, so the ratio explodes into a fake
   * hundreds-of-percent "move".
   *
   * `afterDate` is exclusive and `throughDate` inclusive — pass the prior
   * trading day and today, so a split dated on the prior day (already reflected
   * in that day's close) is not counted. A single page with a high limit is
   * enough: even a busy day has only a handful of market-wide splits, far below
   * the 1000 cap, so pagination is intentionally not followed here.
   */
  async getSplitsInRange(
    afterDate: string,
    throughDate: string,
  ): Promise<
    Array<{
      ticker: string;
      executionDate: string;
      splitFrom: number;
      splitTo: number;
    }>
  > {
    const res = await fetchJson<any>(
      `${this.baseUrl}/v3/reference/splits` +
        `?execution_date.gt=${afterDate}&execution_date.lte=${throughDate}` +
        `&order=desc&sort=execution_date&limit=1000&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []).map((s: any) => ({
      ticker: s.ticker,
      executionDate: s.execution_date,
      splitFrom: s.split_from,
      splitTo: s.split_to,
    }));
  }

  /**
   * Live session state straight from the exchange feed, replacing the
   * hand-maintained holiday set the header pill computed from a local clock.
   */
  async getMarketStatus(): Promise<{
    market: string;
    earlyHours: boolean;
    afterHours: boolean;
    exchanges: Record<string, string>;
    serverTime: string;
  }> {
    return fetchJson(
      `${this.baseUrl}/v1/marketstatus/now?apiKey=${this.apiKey}`,
    );
  }

  /** Upcoming market holidays and early closes. */
  async getUpcomingMarketHolidays(): Promise<
    Array<{
      date: string;
      exchange: string;
      name: string;
      status: string;
      open?: string;
      close?: string;
    }>
  > {
    const res = await fetchJson<any>(
      `${this.baseUrl}/v1/marketstatus/upcoming?apiKey=${this.apiKey}`,
    );
    return Array.isArray(res) ? res : [];
  }

  /**
   * US Treasury yield curve. Authorized on this plan and previously unused —
   * the "10Y Yield" tile was showing TLT, a long-treasury ETF that moves
   * INVERSELY to the yield it was labelled as.
   */
  async getTreasuryYields(limit = 2): Promise<
    Array<{
      date: string;
      yield1Month: number | null;
      yield3Month: number | null;
      yield1Year: number | null;
      yield2Year: number | null;
      yield5Year: number | null;
      yield10Year: number | null;
      yield30Year: number | null;
    }>
  > {
    const res = await fetchJson<any>(
      `${this.baseUrl}/fed/v1/treasury-yields?limit=${limit}&sort=date.desc&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []).map((r: any) => ({
      date: r.date,
      yield1Month: r.yield_1_month ?? null,
      yield3Month: r.yield_3_month ?? null,
      yield1Year: r.yield_1_year ?? null,
      yield2Year: r.yield_2_year ?? null,
      yield5Year: r.yield_5_year ?? null,
      yield10Year: r.yield_10_year ?? null,
      yield30Year: r.yield_30_year ?? null,
    }));
  }

  /**
   * Universal snapshot. Carries the extended-hours fields the delayed
   * per-ticker snapshot does not: `early_trading_change_percent` and
   * `late_trading_change_percent`, which are what the Premarket / After-Hours
   * feeds need. Still 15-minute delayed like everything else on this plan.
   */
  async getUniversalSnapshot(tickers: string[]): Promise<
    Array<{
      ticker: string;
      name: string | null;
      marketStatus: string | null;
      price: number | null;
      change: number | null;
      changePercent: number | null;
      earlyTradingChangePercent: number | null;
      lateTradingChangePercent: number | null;
      open: number | null;
      high: number | null;
      low: number | null;
      previousClose: number | null;
      volume: number | null;
      vwap: number | null;
    }>
  > {
    if (tickers.length === 0) return [];
    const res = await fetchJson<any>(
      `${this.baseUrl}/v3/snapshot?ticker.any_of=${tickers.join(",")}` +
        `&limit=250&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []).map((r: any) => {
      const s = r.session ?? {};
      // Every numeric snapshot field is passed through finiteOrNull so a vendor
      // NaN/Infinity degrades to null (already the field's type) instead of
      // flowing into the Premarket/After-Hours change math.
      //
      // Price is close-aware. `s.price` is the last-trade price; off-hours it can
      // drift from the official regular-session close (`s.close`) that consumer
      // finance sites display (this is the ~5% SIRI weekend gap). So OUTSIDE
      // regular hours we prefer the regular-session close, and DURING regular
      // hours we keep the live last-trade price. `r.market_status` is Polygon's
      // outer session state ("open" only during RTH); previous_close is the last
      // resort. Field names match the snake_case the rest of this map already uses.
      const marketOpen = r.market_status === "open";
      const sessionPrice = marketOpen
        ? finiteOrNull(s.price ?? s.close ?? s.previous_close)
        : finiteOrNull(s.close ?? s.price ?? s.previous_close);
      return {
        ticker: r.ticker,
        name: r.name ?? null,
        marketStatus: r.market_status ?? null,
        price: sessionPrice,
        change: finiteOrNull(s.change),
        changePercent: finiteOrNull(s.change_percent),
        earlyTradingChangePercent: finiteOrNull(s.early_trading_change_percent),
        lateTradingChangePercent: finiteOrNull(s.late_trading_change_percent),
        open: finiteOrNull(s.open),
        high: finiteOrNull(s.high),
        low: finiteOrNull(s.low),
        previousClose: finiteOrNull(s.previous_close),
        volume: finiteOrNull(s.volume),
        vwap: finiteOrNull(s.vwap),
      };
    });
  }

  async getTickerDetails(ticker: string): Promise<any> {
    const res = await fetchJson<{ results: Record<string, unknown> }>(
      `${this.baseUrl}/v3/reference/tickers/${ticker}?apiKey=${this.apiKey}`,
    );
    return res.results;
  }

  /**
   * Company logo bytes from Polygon's ticker `branding` (icon preferred, then
   * logo). The branding URLs require the API key appended, so this must run
   * server-side — the browser never sees the key. Returns null when Polygon has
   * no branding for the ticker (caller falls back to a letter tile).
   */
  async getBrandingImage(
    ticker: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    let details: any = null;
    try {
      details = await this.getTickerDetails(ticker);
    } catch {
      return null;
    }
    const branding = details?.branding as
      { icon_url?: string; logo_url?: string } | undefined;
    const base = branding?.icon_url ?? branding?.logo_url;
    if (!base) return null;
    const url = base.includes("?")
      ? `${base}&apiKey=${this.apiKey}`
      : `${base}?apiKey=${this.apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") ?? "image/png";
    const data = Buffer.from(await resp.arrayBuffer());
    return { data, contentType };
  }

  async getTtmEps(ticker: string): Promise<number | null> {
    const res = await fetchJson<any>(
      `${this.baseUrl}/vX/reference/financials?ticker=${ticker}` +
        `&timeframe=ttm&limit=1&apiKey=${this.apiKey}`,
    );
    const inc = res.results?.[0]?.financials?.income_statement;
    const eps =
      inc?.diluted_earnings_per_share?.value ??
      inc?.basic_earnings_per_share?.value;
    if (typeof eps === "number") return eps;
    // Fallback: Polygon carries no TTM row for many mid/small caps — approximate
    // trailing-twelve-month EPS by summing the 4 most recent quarterly diluted
    // EPS. Only when all 4 quarters carry a value, so a short history (recent
    // IPO) never understates TTM with a partial sum.
    return this.getTtmEpsFromQuarters(ticker);
  }

  /** TTM EPS approximated as the sum of the last 4 quarterly EPS, else null. */
  private async getTtmEpsFromQuarters(ticker: string): Promise<number | null> {
    const res = await fetchJson<any>(
      `${this.baseUrl}/vX/reference/financials?ticker=${ticker}` +
        `&timeframe=quarterly&limit=4&apiKey=${this.apiKey}`,
    );
    const rows = res.results ?? [];
    if (rows.length < 4) return null;
    let sum = 0;
    for (const r of rows.slice(0, 4)) {
      const inc = r?.financials?.income_statement;
      const q =
        inc?.diluted_earnings_per_share?.value ??
        inc?.basic_earnings_per_share?.value;
      if (typeof q !== "number") return null;
      sum += q;
    }
    return Math.round(sum * 100) / 100;
  }

  /**
   * Market-wide reported financials filed within a date range, paginated — the
   * source for the PAST earnings calendar. Polygon has no earnings-calendar or
   * estimate feed, so `filing_date` (when the 10-Q/10-K reached the SEC) is the
   * reporting date, and only actuals are returned (no estimates / beat-miss).
   */
  async getFinancialsByFilingDate(
    from: string,
    to: string,
  ): Promise<
    Array<{
      ticker: string;
      companyName: string | null;
      filingDate: string | null;
      periodEnd: string | null;
      fiscalPeriod: string | null;
      fiscalYear: string | null;
      epsActual: number | null;
      revenueActual: number | null;
      netIncome: number | null;
    }>
  > {
    type Row = {
      ticker: string;
      companyName: string | null;
      filingDate: string | null;
      periodEnd: string | null;
      fiscalPeriod: string | null;
      fiscalYear: string | null;
      epsActual: number | null;
      revenueActual: number | null;
      netIncome: number | null;
    };
    const out: Row[] = [];
    // financials caps `limit` at 100 (unlike the 1000 other reference endpoints allow).
    let url =
      `${this.baseUrl}/vX/reference/financials?filing_date.gte=${from}` +
      `&filing_date.lte=${to}&timeframe=quarterly&order=asc&sort=filing_date` +
      `&limit=100&apiKey=${this.apiKey}`;
    while (url) {
      const res = await fetchJson<any>(url);
      for (const p of res.results ?? []) {
        const ticker = p.tickers?.[0];
        if (!ticker) continue;
        const inc = p.financials?.income_statement ?? {};
        const v = (k: string) =>
          typeof inc[k]?.value === "number" ? (inc[k].value as number) : null;
        out.push({
          ticker,
          companyName: p.company_name ?? null,
          filingDate: p.filing_date ?? null,
          periodEnd: p.end_date ?? null,
          fiscalPeriod: p.fiscal_period ?? null,
          fiscalYear: p.fiscal_year ?? null,
          epsActual:
            v("diluted_earnings_per_share") ?? v("basic_earnings_per_share"),
          revenueActual: v("revenues"),
          netIncome: v("net_income_loss"),
        });
      }
      url = res.next_url ? `${res.next_url}&apiKey=${this.apiKey}` : null;
      if (url) await sleep(this.pageDelayMs);
    }
    return out;
  }

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
    const res = await fetchJson<any>(
      `${this.baseUrl}/vX/reference/financials?ticker=${ticker}` +
        `&timeframe=${timeframe}&limit=${limit}&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []).map((p: any) => {
      const inc = p.financials?.income_statement ?? {};
      // Assert the vendor's per-node currency unit before trusting the value: a
      // node explicitly denominated in a NON-USD currency is nulled (with a
      // warning) rather than stored as if it were the raw USD dollars every
      // consumer assumes. USD / per-share / unitless nodes pass through unchanged.
      const v = (k: string) => {
        const node = inc[k];
        const badUnit = nonUsdCurrencyUnit(node?.unit);
        if (badUnit) {
          this.logger.warn(
            `Non-USD unit "${badUnit}" on income_statement.${k} for ${ticker}; nulling value.`,
          );
          return null;
        }
        return node?.value ?? null;
      };
      return {
        fiscalYear: p.fiscal_year ?? null,
        fiscalPeriod: p.fiscal_period ?? null,
        endDate: p.end_date ?? null,
        revenue: v("revenues"),
        costOfRevenue: v("cost_of_revenue"),
        grossProfit: v("gross_profit"),
        netIncome: v("net_income_loss"),
        operatingIncome: v("operating_income_loss"),
        dilutedEps: v("diluted_earnings_per_share"),
      };
    });
  }

  /**
   * All three statements for one ticker. `getIncomeStatements` above reads only
   * the income statement because that is all the growth job needs; the same
   * response has always carried `balance_sheet` and `cash_flow_statement`
   * alongside it, so the balance-sheet and cash-flow panels were being
   * fabricated from data already on the wire.
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
    const res = await fetchJson<any>(
      `${this.baseUrl}/vX/reference/financials?ticker=${ticker}` +
        `&timeframe=${timeframe}&limit=${limit}&apiKey=${this.apiKey}`,
    );
    // Every statement node is `{ value, unit, label, order }`; only `value` is
    // read. Statements are flattened wholesale rather than field-by-field so a
    // new panel needs no vendor-layer change.
    const values = (node: Record<string, any> | undefined, section: string) =>
      Object.fromEntries(
        Object.entries(node ?? {}).map(([k, v]) => {
          // Same non-USD currency assertion as getIncomeStatements: a node
          // explicitly denominated in a foreign currency is nulled + warned
          // rather than stored as raw USD dollars. USD / per-share / unitless
          // (typeof value !== number) nodes pass through unchanged.
          const badUnit = nonUsdCurrencyUnit(v?.unit);
          if (badUnit) {
            this.logger.warn(
              `Non-USD unit "${badUnit}" on ${section}.${k} for ${ticker}; nulling value.`,
            );
            return [k, null];
          }
          return [k, typeof v?.value === "number" ? v.value : null];
        }),
      );
    return (res.results ?? []).map((p: any) => ({
      fiscalYear: p.fiscal_year ?? null,
      fiscalPeriod: p.fiscal_period ?? null,
      endDate: p.end_date ?? null,
      filingDate: p.filing_date ?? null,
      income: values(p.financials?.income_statement, "income_statement"),
      balanceSheet: values(p.financials?.balance_sheet, "balance_sheet"),
      cashFlow: values(p.financials?.cash_flow_statement, "cash_flow_statement"),
    }));
  }

  async getSectorPerformance(): Promise<
    Array<{
      date: string;
      sector: string;
      exchange: string;
      averageChange: number;
    }>
  > {
    const SECTOR_ETFS = {
      Technology: "XLK",
      "Financial Services": "XLF",
      Energy: "XLE",
      Healthcare: "XLV",
      Industrials: "XLI",
      "Consumer Defensive": "XLP",
      "Consumer Cyclical": "XLY",
      Utilities: "XLU",
      "Basic Materials": "XLB",
      "Real Estate": "XLRE",
      "Communication Services": "XLC",
    };
    const out = [];
    for (const [sector, etf] of Object.entries(SECTOR_ETFS)) {
      const q = await this.getDailyQuote(etf);
      if (!q) continue;
      out.push({
        date: new Date(q.t).toISOString().slice(0, 10),
        sector,
        exchange: "ETF-proxy",
        averageChange: q.dp,
      });
    }
    return out;
  }

  async getDailyQuote(ticker: string): Promise<{
    c: number;
    d: number;
    dp: number;
    o: number;
    h: number;
    l: number;
    pc: number;
    t: number;
  } | null> {
    const to = new Date();
    const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const bars = await this.getAggsRange(ticker, iso(from), iso(to));
    if (bars.length === 0) return null;
    const latest = bars[bars.length - 1];
    const prior = bars.length > 1 ? bars[bars.length - 2] : null;
    const pc = prior ? prior.c : latest.o;
    const d = latest.c - pc;
    return {
      c: latest.c,
      d,
      dp: pc ? (d / pc) * 100 : 0,
      o: latest.o,
      h: latest.h,
      l: latest.l,
      pc,
      t: latest.t,
    };
  }

  async getDividendsCalendar(
    from: string,
    to: string,
  ): Promise<
    Array<{
      vendorEventId: string | null;
      dividendType: string | null;
      symbol: string;
      date: string;
      recordDate: string | null;
      paymentDate: string | null;
      declarationDate: string | null;
      // Nullable: Polygon can omit cash_amount on a calendar row. Read null-safe
      // below; the dividends job guards falsy amounts and stores the amount
      // as-is (never a fabricated 0).
      dividend: number | null;
      yield: number | null;
      frequency: string | null;
    }>
  > {
    const FREQ = {
      0: "One-Time",
      1: "Annual",
      2: "Semi-Annual",
      4: "Quarterly",
      12: "Monthly",
    };
    const out = [];
    let url =
      `${this.baseUrl}/v3/reference/dividends?ex_dividend_date.gte=${from}` +
      `&ex_dividend_date.lte=${to}&limit=1000&apiKey=${this.apiKey}`;
    while (url) {
      const res = await fetchJson<any>(url);
      for (const d of res.results ?? []) {
        out.push({
          // Vendor's stable per-event id. Required because a company can pay a
          // regular AND a special dividend on the SAME ex-date (e.g. JBSS: CD
          // $0.95 + SC $1.05, both ex-2026-08-17), so symbol+date is not unique.
          vendorEventId: d.id ?? null,
          dividendType: d.dividend_type ?? null,
          symbol: d.ticker,
          date: d.ex_dividend_date,
          recordDate: d.record_date ?? null,
          paymentDate: d.pay_date ?? null,
          declarationDate: d.declaration_date ?? null,
          dividend: d.cash_amount ?? null,
          yield: null,
          frequency: d.frequency != null ? (FREQ[d.frequency] ?? null) : null,
        });
      }
      url = res.next_url ? `${res.next_url}&apiKey=${this.apiKey}` : null;
      if (url) await sleep(this.pageDelayMs);
    }
    return out;
  }

  async getIpoCalendar(
    from: string,
    to: string,
  ): Promise<
    Array<{
      date: string;
      symbol: string;
      name: string;
      exchange: string;
      price: string | null;
      numberOfShares: number | null;
      totalSharesValue: number | null;
      status: string;
    }>
  > {
    const out = [];
    let url =
      `${this.baseUrl}/vX/reference/ipos?listing_date.gte=${from}` +
      `&listing_date.lte=${to}&limit=1000&apiKey=${this.apiKey}`;
    while (url) {
      const res = await fetchJson<any>(url);
      for (const r of res.results ?? []) {
        const lo = r.lowest_offer_price ?? r.final_issue_price ?? null;
        const hi = r.highest_offer_price ?? r.final_issue_price ?? null;
        const price =
          lo != null && hi != null
            ? lo === hi
              ? String(lo)
              : `${lo}-${hi}`
            : lo != null
              ? String(lo)
              : null;
        out.push({
          date: r.listing_date ?? r.announced_date ?? "",
          symbol: r.ticker ?? "",
          name: r.issuer_name ?? "",
          exchange: r.primary_exchange ?? "",
          price,
          numberOfShares: r.max_shares_offered ?? r.shares_outstanding ?? null,
          totalSharesValue: r.total_offer_size ?? null,
          status: r.ipo_status ?? "",
        });
      }
      url = res.next_url ? `${res.next_url}&apiKey=${this.apiKey}` : null;
      if (url) await sleep(this.pageDelayMs);
    }
    return out;
  }

  async getAllTickers(active = true): Promise<PolygonTickerRef[]> {
    const all: PolygonTickerRef[] = [];
    let url = `${this.baseUrl}/v3/reference/tickers?market=stocks&active=${active}&limit=1000&apiKey=${this.apiKey}`;
    while (url) {
      const res = await fetchJson<{
        results?: PolygonTickerRef[];
        next_url?: string;
      }>(url);
      all.push(...(res.results ?? []));
      url = res.next_url ? `${res.next_url}&apiKey=${this.apiKey}` : null;
      if (url) await sleep(this.pageDelayMs);
    }
    return all;
  }

  async getOptionContracts(
    underlyingTicker: string,
    fromDate: string,
    limit = 20,
  ): Promise<PolygonOptionContract[]> {
    const res = await fetchJson<{ results?: PolygonOptionContract[] }>(
      `${this.baseUrl}/v3/reference/options/contracts?underlying_ticker=${underlyingTicker}` +
        `&expiration_date.gte=${fromDate}&sort=expiration_date&order=asc&limit=${limit}&apiKey=${this.apiKey}`,
    );
    return res.results ?? [];
  }

  async getOptionLatestBar(
    optionTicker: string,
    fromDate: string,
    toDate: string,
  ): Promise<PolygonAggBar | null> {
    const res = await fetchJson<{ results?: PolygonAggBar[] }>(
      `${this.baseUrl}/v2/aggs/ticker/${optionTicker}/range/1/day/${fromDate}/${toDate}?sort=desc&limit=1&apiKey=${this.apiKey}`,
    );
    return res.results?.[0] ?? null;
  }

  async getNews(
    ticker: string,
    from: string,
    to: string,
    limit = 10,
  ): Promise<PolygonNewsArticle[]> {
    const res = await fetchJson<{ results?: PolygonNewsArticle[] }>(
      `${this.baseUrl}/v2/reference/news?ticker=${ticker}` +
        `&published_utc.gte=${from}&published_utc.lte=${to}` +
        `&order=desc&sort=published_utc&limit=${limit}&apiKey=${this.apiKey}`,
    );
    return res.results ?? [];
  }

  /**
   * MARKET-WIDE newest news (NO ticker filter) — the freshest stories across the
   * whole market, newest-first. Feeds the "Live" intraday feed's HEAD so its top
   * is always the absolute-newest article regardless of the per-ticker cursor
   * batch (which refreshes only ~80 tickers/run and can lag a fresh story by
   * hours). `limit` is higher than the per-ticker call because one request must
   * span many tickers. Same shape as getNews so the adapter maps them identically.
   */
  async getMarketNews(
    from: string,
    to: string,
    limit = 100,
  ): Promise<PolygonNewsArticle[]> {
    const res = await fetchJson<{ results?: PolygonNewsArticle[] }>(
      `${this.baseUrl}/v2/reference/news` +
        `?published_utc.gte=${from}&published_utc.lte=${to}` +
        `&order=desc&sort=published_utc&limit=${limit}&apiKey=${this.apiKey}`,
    );
    return res.results ?? [];
  }
}
