import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchJson } from '../../common/http.util';

const BASE_URL = 'https://api.polygon.io';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAGE_DELAY_MS = 12_500;

interface PolygonAggBar {
  T: string;
  v: number;
  o: number;
  c: number;
  h: number;
  l: number;
  t: number;
  n?: number;
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

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get('POLYGON_API_KEY', '');
    if (!this.apiKey) {
      this.logger.warn('POLYGON_API_KEY not set — Polygon-backed jobs will fail.');
    }
  }

  async getGroupedDaily(date: string): Promise<PolygonAggBar[]> {
    const res = await fetchJson<{ results?: PolygonAggBar[] }>(
      `${BASE_URL}/v2/aggs/grouped/locale/us/market/stocks/${date}?apiKey=${this.apiKey}`,
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
  ): Promise<PolygonAggBar[]> {
    const res = await fetchJson<{ results?: PolygonAggBar[] }>(
      `${BASE_URL}/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&apiKey=${this.apiKey}`,
    );
    return res.results ?? [];
  }

  async getTickerDetails(ticker: string): Promise<any> {
    const res = await fetchJson<{ results: Record<string, unknown> }>(
      `${BASE_URL}/v3/reference/tickers/${ticker}?apiKey=${this.apiKey}`,
    );
    return res.results;
  }

  async getTtmEps(ticker: string): Promise<number | null> {
    const res = await fetchJson<any>(
      `${BASE_URL}/vX/reference/financials?ticker=${ticker}` +
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
      revenue: number | null;
      costOfRevenue: number | null;
      grossProfit: number | null;
      dilutedEps: number | null;
    }>
  > {
    const res = await fetchJson<any>(
      `${BASE_URL}/vX/reference/financials?ticker=${ticker}` +
        `&timeframe=${timeframe}&limit=${limit}&apiKey=${this.apiKey}`,
    );
    return (res.results ?? []).map((p: any) => {
      const inc = p.financials?.income_statement ?? {};
      const v = (k: string) => inc[k]?.value ?? null;
      return {
        fiscalYear: p.fiscal_year ?? null,
        revenue: v('revenues'),
        costOfRevenue: v('cost_of_revenue'),
        grossProfit: v('gross_profit'),
        dilutedEps: v('diluted_earnings_per_share'),
      };
    });
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
    let url = `${BASE_URL}/v3/reference/dividends?ex_dividend_date.gte=${from}` +
      `&ex_dividend_date.lte=${to}&limit=1000&apiKey=${this.apiKey}`;
    while (url) {
      const res = await fetchJson<any>(url);
      for (const d of res.results ?? []) {
        out.push({
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
      if (url) await sleep(PAGE_DELAY_MS);
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
    let url = `${BASE_URL}/vX/reference/ipos?listing_date.gte=${from}` +
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
      if (url) await sleep(PAGE_DELAY_MS);
    }
    return out;
  }

  async getAllTickers(active = true): Promise<PolygonTickerRef[]> {
    const all: PolygonTickerRef[] = [];
    let url = `${BASE_URL}/v3/reference/tickers?market=stocks&active=${active}&limit=1000&apiKey=${this.apiKey}`;
    while (url) {
      const res = await fetchJson<{ results?: PolygonTickerRef[]; next_url?: string }>(url);
      all.push(...(res.results ?? []));
      url = res.next_url ? `${res.next_url}&apiKey=${this.apiKey}` : null;
      if (url) await sleep(PAGE_DELAY_MS);
    }
    return all;
  }

  async getOptionContracts(
    underlyingTicker: string,
    fromDate: string,
    limit = 20,
  ): Promise<PolygonOptionContract[]> {
    const res = await fetchJson<{ results?: PolygonOptionContract[] }>(
      `${BASE_URL}/v3/reference/options/contracts?underlying_ticker=${underlyingTicker}` +
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
      `${BASE_URL}/v2/aggs/ticker/${optionTicker}/range/1/day/${fromDate}/${toDate}?sort=desc&limit=1&apiKey=${this.apiKey}`,
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
      `${BASE_URL}/v2/reference/news?ticker=${ticker}` +
        `&published_utc.gte=${from}&published_utc.lte=${to}` +
        `&order=desc&sort=published_utc&limit=${limit}&apiKey=${this.apiKey}`,
    );
    return res.results ?? [];
  }
}
