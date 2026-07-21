import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchJson } from '../../common/http.util';

const BASE_URL = 'https://finnhub.io/api/v1';

export interface FinnhubQuote {
  c: number;
  d: number;
  dp: number;
  h: number;
  l: number;
  o: number;
  pc: number;
  t: number;
}

export interface FinnhubIpoEvent {
  date: string;
  symbol: string | null;
  name: string;
  exchange: string | null;
  price: string | null;
  numberOfShares: number | null;
  totalSharesValue: number | null;
  status: 'expected' | 'priced' | 'filed' | 'withdrawn';
}

@Injectable()
export class FinnhubService {
  private readonly logger = new Logger(FinnhubService.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get('FINNHUB_API_KEY', '');
    if (!this.apiKey) {
      this.logger.warn('FINNHUB_API_KEY not set — Finnhub-backed jobs will fail.');
    }
  }

  async getQuote(symbol: string): Promise<FinnhubQuote> {
    return fetchJson(`${BASE_URL}/quote?symbol=${symbol}&token=${this.apiKey}`);
  }

  async getCompanyNews(
    symbol: string,
    from: string,
    to: string,
  ): Promise<
    {
      id: number;
      headline: string;
      summary: string;
      source: string;
      url: string;
      datetime: number;
      category: string;
    }[]
  > {
    return fetchJson(
      `${BASE_URL}/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${this.apiKey}`,
    );
  }

  async getEconomicCalendar(): Promise<{ economicCalendar: unknown[] }> {
    return fetchJson(`${BASE_URL}/calendar/economic?token=${this.apiKey}`);
  }

  async getIpoCalendar(from: string, to: string): Promise<FinnhubIpoEvent[]> {
    const res = await fetchJson<{ ipoCalendar?: FinnhubIpoEvent[] }>(
      `${BASE_URL}/calendar/ipo?from=${from}&to=${to}&token=${this.apiKey}`,
    );
    return res.ipoCalendar ?? [];
  }

  /**
   * Earnings calendar for a date range. Far richer than the FMP calendar the
   * `earnings` job uses (verified 488 rows/week vs FMP's 10) and — crucially for
   * the EPS-history estimate line — carries `epsEstimate` per report date plus
   * the BMO/AMC session `hour`.
   */
  async getEarningsCalendar(
    from: string,
    to: string,
    symbol?: string,
  ): Promise<
    Array<{
      symbol: string;
      date: string;
      hour: string;
      quarter: number;
      year: number;
      epsEstimate: number | null;
      epsActual: number | null;
      revenueEstimate: number | null;
      revenueActual: number | null;
    }>
  > {
    const sym = symbol ? `&symbol=${symbol}` : '';
    const res = await fetchJson<{ earningsCalendar?: any[] }>(
      `${BASE_URL}/calendar/earnings?from=${from}&to=${to}${sym}&token=${this.apiKey}`,
    );
    return res.earningsCalendar ?? [];
  }
}
