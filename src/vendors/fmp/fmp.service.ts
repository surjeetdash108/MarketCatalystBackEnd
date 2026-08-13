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
}
