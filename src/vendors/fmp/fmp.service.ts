import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchJson } from '../../common/http.util';

const BASE_URL = 'https://financialmodelingprep.com/stable';

@Injectable()
export class FmpService {
  private readonly logger = new Logger(FmpService.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get('FMP_API_KEY', '');
    if (!this.apiKey) {
      this.logger.warn('FMP_API_KEY not set — FMP-backed jobs will fail.');
    }
  }

  private async get(path: string): Promise<any> {
    const sep = path.includes('?') ? '&' : '?';
    return fetchJson(`${BASE_URL}/${path}${sep}apikey=${this.apiKey}`);
  }

  async getProfile(symbol: string): Promise<any> {
    const res = await this.get(`profile?symbol=${symbol}`);
    return res[0] ?? null;
  }

  async getRatiosTtm(symbol: string): Promise<any> {
    const res = await this.get(`ratios-ttm?symbol=${symbol}`);
    return res[0] ?? null;
  }

  async getPeers(symbol: string): Promise<
    {
      symbol: string;
      companyName: string;
      price: number;
      mktCap: number;
    }[]
  > {
    return this.get(`stock-peers?symbol=${symbol}`);
  }

  async getGradesConsensus(symbol: string): Promise<any> {
    const res = await this.get(`grades-consensus?symbol=${symbol}`);
    return res[0] ?? null;
  }

  async getSectorPerformanceSnapshot(date: string): Promise<
    {
      date: string;
      sector: string;
      exchange: string;
      averageChange: number;
    }[]
  > {
    return this.get(`sector-performance-snapshot?date=${date}`);
  }

  async getBiggestGainers(): Promise<
    {
      symbol: string;
      name: string;
      change: number;
      price: number;
      changesPercentage: number;
    }[]
  > {
    return this.get('biggest-gainers');
  }

  async getBiggestLosers(): Promise<
    {
      symbol: string;
      name: string;
      change: number;
      price: number;
      changesPercentage: number;
    }[]
  > {
    return this.get('biggest-losers');
  }

  async getEarningsCalendar(
    from: string,
    to: string,
  ): Promise<
    {
      symbol: string;
      date: string;
      epsActual: number | null;
      epsEstimated: number | null;
      revenueActual: number | null;
      revenueEstimated: number | null;
    }[]
  > {
    return this.get(`earnings-calendar?from=${from}&to=${to}`);
  }

  async getDividendsCalendar(
    from: string,
    to: string,
  ): Promise<
    {
      symbol: string;
      date: string;
      recordDate: string | null;
      paymentDate: string | null;
      declarationDate: string | null;
      dividend: number;
      yield: number | null;
      frequency: string | null;
    }[]
  > {
    return this.get(`dividends-calendar?from=${from}&to=${to}`);
  }
}
