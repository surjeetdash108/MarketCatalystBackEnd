import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchText } from '../../common/http.util';

const BASE_URL = 'https://www.alphavantage.co/query';

export interface AlphaVantageEarningsRow {
  symbol: string;
  name: string;
  reportDate: string;
  fiscalDateEnding: string;
  estimate: number | null;
  currency: string;
}

/**
 * Minimal CSV parser (quoted fields, escaped `""`, CRLF/LF) — Alpha
 * Vantage's EARNINGS_CALENDAR only speaks CSV, and company names in it can
 * contain commas (e.g. "American International Group, Inc."), so a plain
 * `split(',')` would misalign columns.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

@Injectable()
export class AlphaVantageService {
  private readonly logger = new Logger(AlphaVantageService.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get('ALPHAVANTAGE_API_KEY', '');
    if (!this.apiKey) {
      this.logger.warn(
        'ALPHAVANTAGE_API_KEY not set — Alpha Vantage-backed endpoints will fail.',
      );
    }
  }

  /**
   * Market-wide forward earnings calendar. Alpha Vantage has no market-wide
   * actuals feed (only a per-symbol EARNINGS endpoint), so unlike FMP's
   * calendar this is estimate-only and forward-looking — `horizon` picks how
   * far out (Alpha Vantage only supports these three fixed windows, not an
   * arbitrary from/to range).
   */
  async getEarningsCalendar(
    horizon: '3month' | '6month' | '12month' = '3month',
  ): Promise<AlphaVantageEarningsRow[]> {
    const text = await fetchText(
      `${BASE_URL}?function=EARNINGS_CALENDAR&horizon=${horizon}&apikey=${this.apiKey}`,
    );
    const trimmed = text.trim();
    // Rate-limit / bad-key responses come back as a 200 with a JSON body
    // even on this CSV-only endpoint — surface that instead of returning a
    // single bogus "row" parsed out of the JSON text.
    if (trimmed.startsWith('{')) {
      let message = trimmed;
      try {
        const parsed = JSON.parse(trimmed);
        message = parsed['Error Message'] ?? parsed['Note'] ?? parsed['Information'] ?? trimmed;
      } catch {
        // keep raw text
      }
      throw new Error(`Alpha Vantage EARNINGS_CALENDAR error: ${message}`);
    }

    const [header, ...rows] = parseCsv(trimmed);
    if (!header) return [];
    const symbolIdx = header.indexOf('symbol');
    const nameIdx = header.indexOf('name');
    const reportDateIdx = header.indexOf('reportDate');
    const fiscalDateEndingIdx = header.indexOf('fiscalDateEnding');
    const estimateIdx = header.indexOf('estimate');
    const currencyIdx = header.indexOf('currency');

    return rows
      .filter((r) => r.length >= header.length && r[symbolIdx])
      .map((r) => ({
        symbol: r[symbolIdx],
        name: r[nameIdx] ?? '',
        reportDate: r[reportDateIdx],
        fiscalDateEnding: r[fiscalDateEndingIdx] ?? '',
        estimate: r[estimateIdx] ? Number(r[estimateIdx]) : null,
        currency: r[currencyIdx] || 'USD',
      }));
  }
}
