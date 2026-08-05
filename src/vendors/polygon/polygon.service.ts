import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchJson } from '../../common/http.util';

// Polygon rebranded to Massive (Oct 2025); api.polygon.io still resolves but is
// being phased out in favour of api.massive.com. Kept configurable so the host
// can be cut over via env once a key is confirmed working on the new one,
// without a redeploy of changed code.
const DEFAULT_BASE_URL = 'https://api.polygon.io';

// Delay between pages of a paginated endpoint. 12.5s is the free Basic tier's
// 5-calls-per-minute budget; EVERY paid tier is unlimited, so on a paid key
// this should be 0 — it otherwise adds minutes per run to getAllTickers,
// getDividendsCalendar and getIpoCalendar for no reason.
const DEFAULT_PAGE_DELAY_MS = 12_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  contract_type: 'call' | 'put';
  strike_price: number;
  expiration_date: string;
  exercise_style?: string;
  shares_per_contract?: number;
}

export interface PolygonNewsInsight {
  ticker: string;
  sentiment: 'positive' | 'negative' | 'neutral';
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
    this.apiKey = this.config.get('POLYGON_API_KEY', '');
    if (!this.apiKey) {
      this.logger.warn('POLYGON_API_KEY not set — Polygon-backed jobs will fail.');
    }

    this.baseUrl = this.config
      .get('POLYGON_API_BASE_URL', DEFAULT_BASE_URL)
      .replace(/\/$/, '');

    // Parsed defensively: a typo or a negative value must fall back to the safe
    // free-tier delay rather than silently hammering the API. Blank is treated
    // as unset too — `POLYGON_PAGE_DELAY_MS=` is a natural way to leave the var
    // empty, and Number('') is 0, which would disable the throttle entirely.
    const rawDelay = String(
      this.config.get('POLYGON_PAGE_DELAY_MS', ''),
    ).trim();
    const parsedDelay = rawDelay === '' ? NaN : Number(rawDelay);
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
      this.logger.log(`No grouped-daily data for ${date} (holiday/weekend) — trying prior day`);
    }
    return null;
  }

  async getAggsRange(
    ticker: string,
    from: string,
    to: string,
    timespan = 'day',
    multiplier = 1,
    limit = 5000,
  ): Promise<PolygonAggBar[]> {
    const res = await fetchJson<{ results?: PolygonAggBar[] }>(
      `${this.baseUrl}/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${from}/${to}` +
        `?adjusted=true&sort=asc&limit=${limit}&apiKey=${this.apiKey}`,
    );
    return res.results ?? [];
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
    timespan: 'minute' | 'hour',
    from: string,
    to: string,
  ): Promise<PolygonAggBar[]> {
    return this.getAggsRange(ticker, from, to, timespan, multiplier, 50_000);
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
      cashAmount: number;
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
      cashAmount: d.cash_amount,
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
    Array<{ ticker: string; executionDate: string; splitFrom: number; splitTo: number }>
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
    return fetchJson(`${this.baseUrl}/v1/marketstatus/now?apiKey=${this.apiKey}`);
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

  // ─────────────────────────────────────────────────────────────────────────
  // Additional AUTHORIZED Polygon endpoints — vendor layer kept complete so any
  // future feature can wire them without touching this file. Not yet consumed
  // by a controller/UI (independent data); see Doc/POLYGON-FEATURE-CROSSCHECK.
  // ─────────────────────────────────────────────────────────────────────────

  /** CPI inflation series — GET /fed/v1/inflation. Returns raw dated rows. */
  async getInflation(limit = 13): Promise<Array<Record<string, unknown>>> {
    const res = await fetchJson<any>(
      `${this.baseUrl}/fed/v1/inflation?limit=${limit}&sort=date.desc&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []) as Array<Record<string, unknown>>;
  }

  /** Model-implied inflation expectations — GET /fed/v1/inflation-expectations. */
  async getInflationExpectations(limit = 13): Promise<Array<Record<string, unknown>>> {
    const res = await fetchJson<any>(
      `${this.baseUrl}/fed/v1/inflation-expectations?limit=${limit}&sort=date.desc&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []) as Array<Record<string, unknown>>;
  }

  /**
   * FX previous-day aggregate — GET /v2/aggs/ticker/C:{pair}/prev.
   * `pair` is a currency pair like "EURUSD" or "USDJPY".
   */
  async getFxPrevClose(pair: string): Promise<{
    pair: string;
    close: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    volume: number | null;
  } | null> {
    const res = await fetchJson<any>(
      `${this.baseUrl}/v2/aggs/ticker/C:${pair}/prev?adjusted=true&apiKey=${this.apiKey}`,
    );
    const r = res.results?.[0];
    if (!r) return null;
    return {
      pair,
      close: r.c ?? null,
      open: r.o ?? null,
      high: r.h ?? null,
      low: r.l ?? null,
      volume: r.v ?? null,
    };
  }

  /** Daily open/close/high/low for one ticker — GET /v1/open-close/{ticker}/{date}. */
  async getDailyOpenClose(ticker: string, date: string): Promise<Record<string, unknown> | null> {
    const res = await fetchJson<any>(
      `${this.baseUrl}/v1/open-close/${ticker}/${date}?adjusted=true&apiKey=${this.apiKey}`,
    );
    return (res ?? null) as Record<string, unknown> | null;
  }

  /** Corporate/name-change events for a ticker — GET /vX/reference/tickers/{ticker}/events. */
  async getTickerEvents(ticker: string): Promise<Array<Record<string, unknown>>> {
    const res = await fetchJson<any>(
      `${this.baseUrl}/vX/reference/tickers/${ticker}/events?apiKey=${this.apiKey}`,
    );
    return (res.results?.events ?? []) as Array<Record<string, unknown>>;
  }

  /**
   * Vendor-computed technical indicator — GET /v1/indicators/{indicator}/{ticker}.
   * We normally compute our own (technical-indicators.job); this is here for
   * completeness / cross-checking. `indicator` ∈ sma | ema | rsi | macd.
   */
  async getIndicator(
    indicator: 'sma' | 'ema' | 'rsi' | 'macd',
    ticker: string,
    params: { window?: number; timespan?: string; limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const { window = 14, timespan = 'day', limit = 50 } = params;
    const win = indicator === 'macd' ? '' : `&window=${window}`;
    const res = await fetchJson<any>(
      `${this.baseUrl}/v1/indicators/${indicator}/${ticker}?timespan=${timespan}${win}&series_type=close&order=desc&limit=${limit}&apiKey=${this.apiKey}`,
    );
    return (res.results?.values ?? []) as Array<Record<string, unknown>>;
  }

  /** Reference: stock exchanges — GET /v3/reference/exchanges?asset_class=stocks. */
  async getExchanges(): Promise<Array<Record<string, unknown>>> {
    const res = await fetchJson<any>(
      `${this.baseUrl}/v3/reference/exchanges?asset_class=stocks&locale=us&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []) as Array<Record<string, unknown>>;
  }

  /** Reference: trade/quote conditions — GET /v3/reference/conditions. */
  async getConditions(): Promise<Array<Record<string, unknown>>> {
    const res = await fetchJson<any>(
      `${this.baseUrl}/v3/reference/conditions?asset_class=stocks&limit=200&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []) as Array<Record<string, unknown>>;
  }

  /** Reference: ticker types — GET /v3/reference/tickers/types. */
  async getTickerTypes(): Promise<Array<Record<string, unknown>>> {
    const res = await fetchJson<any>(
      `${this.baseUrl}/v3/reference/tickers/types?asset_class=stocks&locale=us&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []) as Array<Record<string, unknown>>;
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
      `${this.baseUrl}/v3/snapshot?ticker.any_of=${tickers.join(',')}` +
        `&limit=250&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []).map((r: any) => {
      const s = r.session ?? {};
      return {
        ticker: r.ticker,
        name: r.name ?? null,
        marketStatus: r.market_status ?? null,
        price: s.price ?? null,
        change: s.change ?? null,
        changePercent: s.change_percent ?? null,
        earlyTradingChangePercent: s.early_trading_change_percent ?? null,
        lateTradingChangePercent: s.late_trading_change_percent ?? null,
        open: s.open ?? null,
        high: s.high ?? null,
        low: s.low ?? null,
        previousClose: s.previous_close ?? null,
        volume: s.volume ?? null,
        vwap: s.vwap ?? null,
      };
    });
  }

  async getTickerDetails(ticker: string): Promise<any> {
    const res = await fetchJson<{ results: Record<string, unknown> }>(
      `${this.baseUrl}/v3/reference/tickers/${ticker}?apiKey=${this.apiKey}`,
    );
    return res.results;
  }

  async getTtmEps(ticker: string): Promise<number | null> {
    const res = await fetchJson<any>(
      `${this.baseUrl}/vX/reference/financials?ticker=${ticker}` +
        `&timeframe=ttm&limit=1&apiKey=${this.apiKey}`,
    );
    const inc = res.results?.[0]?.financials?.income_statement;
    const eps =
      inc?.diluted_earnings_per_share?.value ?? inc?.basic_earnings_per_share?.value;
    return typeof eps === 'number' ? eps : null;
  }

  async getIncomeStatements(
    ticker: string,
    timeframe = 'annual',
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
      const v = (k: string) => inc[k]?.value ?? null;
      return {
        fiscalYear: p.fiscal_year ?? null,
        fiscalPeriod: p.fiscal_period ?? null,
        endDate: p.end_date ?? null,
        revenue: v('revenues'),
        costOfRevenue: v('cost_of_revenue'),
        grossProfit: v('gross_profit'),
        netIncome: v('net_income_loss'),
        operatingIncome: v('operating_income_loss'),
        dilutedEps: v('diluted_earnings_per_share'),
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
    timeframe = 'quarterly',
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
    const values = (node: Record<string, any> | undefined) =>
      Object.fromEntries(
        Object.entries(node ?? {}).map(([k, v]) => [
          k,
          typeof v?.value === 'number' ? v.value : null,
        ]),
      );
    return (res.results ?? []).map((p: any) => ({
      fiscalYear: p.fiscal_year ?? null,
      fiscalPeriod: p.fiscal_period ?? null,
      endDate: p.end_date ?? null,
      filingDate: p.filing_date ?? null,
      income: values(p.financials?.income_statement),
      balanceSheet: values(p.financials?.balance_sheet),
      cashFlow: values(p.financials?.cash_flow_statement),
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
      Technology: 'XLK',
      'Financial Services': 'XLF',
      Energy: 'XLE',
      Healthcare: 'XLV',
      Industrials: 'XLI',
      'Consumer Defensive': 'XLP',
      'Consumer Cyclical': 'XLY',
      Utilities: 'XLU',
      'Basic Materials': 'XLB',
      'Real Estate': 'XLRE',
      'Communication Services': 'XLC',
    };
    const out = [];
    for (const [sector, etf] of Object.entries(SECTOR_ETFS)) {
      const q = await this.getDailyQuote(etf);
      if (!q) continue;
      out.push({
        date: new Date(q.t).toISOString().slice(0, 10),
        sector,
        exchange: 'ETF-proxy',
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
      dividend: number;
      yield: number | null;
      frequency: string | null;
    }>
  > {
    const FREQ = {
      0: 'One-Time',
      1: 'Annual',
      2: 'Semi-Annual',
      4: 'Quarterly',
      12: 'Monthly',
    };
    const out = [];
    let url = `${this.baseUrl}/v3/reference/dividends?ex_dividend_date.gte=${from}` +
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
          dividend: d.cash_amount,
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
    let url = `${this.baseUrl}/vX/reference/ipos?listing_date.gte=${from}` +
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
          date: r.listing_date ?? r.announced_date ?? '',
          symbol: r.ticker ?? '',
          name: r.issuer_name ?? '',
          exchange: r.primary_exchange ?? '',
          price,
          numberOfShares: r.max_shares_offered ?? r.shares_outstanding ?? null,
          totalSharesValue: r.total_offer_size ?? null,
          status: r.ipo_status ?? '',
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
      const res = await fetchJson<{ results?: PolygonTickerRef[]; next_url?: string }>(url);
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
}
