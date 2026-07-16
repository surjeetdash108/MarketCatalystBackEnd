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
}
