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
      this.logger.warn('FMP_API_KEY not set — FMP-backed endpoints will fail.');
    }
  }

  private async get(path: string): Promise<any> {
    const sep = path.includes('?') ? '&' : '?';
    return fetchJson(`${BASE_URL}/${path}${sep}apikey=${this.apiKey}`);
  }

  /**
   * Market-wide earnings calendar. Covers past (epsActual + epsEstimated both
   * present), today, and future (epsEstimated only) in one call — `date` is the
   * true earnings-report date, not an SEC filing date.
   */
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

  /** Biggest gaining stocks of the current session. */
  async getGainers(): Promise<FmpMover[]> {
    return this.get('biggest-gainers');
  }

  /** Biggest losing stocks of the current session. */
  async getLosers(): Promise<FmpMover[]> {
    return this.get('biggest-losers');
  }

  /** Most-active stocks of the current session (by volume). */
  async getMostActive(): Promise<FmpMover[]> {
    return this.get('most-actives');
  }
}

/** One row from FMP's biggest-gainers / biggest-losers / most-actives feeds. */
export interface FmpMover {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changesPercentage: number;
}
