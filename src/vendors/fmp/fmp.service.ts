import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchJson, type FetchJsonOptions } from '../../common/http.util';

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

  private async get(path: string, opts?: FetchJsonOptions): Promise<any> {
    const sep = path.includes('?') ? '&' : '?';
    return fetchJson(`${BASE_URL}/${path}${sep}apikey=${this.apiKey}`, opts);
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

  /**
   * Analyst grades consensus for a single symbol — the current Buy/Hold/Sell
   * vote-count snapshot (NOT a per-firm upgrade/downgrade event feed, which
   * needs a Benzinga-class source). Returns one row per symbol, or [] when FMP
   * has no coverage for the ticker. Shape matches the UI's `AnalystConsensusDoc`
   * (minus the `id`/`ticker` rename the caller applies).
   */
  async getGradesConsensus(symbol: string): Promise<
    {
      symbol: string;
      strongBuy: number;
      buy: number;
      hold: number;
      sell: number;
      strongSell: number;
      consensus: string;
    }[]
  > {
    // Fail-fast: this is one ticker of a best-effort board fetched in parallel.
    // If FMP is momentarily rate-limiting (429), we want THIS call to drop out
    // quickly (→ ticker omitted) rather than burn the default 1s/2s/4s backoff
    // and stall the whole board for 100s+. One quick retry, then give up.
    return this.get(`grades-consensus?symbol=${encodeURIComponent(symbol)}`, {
      retries: 0,
    });
  }
}
