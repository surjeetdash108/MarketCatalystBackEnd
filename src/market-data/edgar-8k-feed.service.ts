import { Injectable, Logger } from '@nestjs/common';
import { TICKER_UNIVERSE } from '../common/ticker-universe';
import { SecEdgarService } from '../vendors/sec-edgar/sec-edgar.service';

const FILINGS_PER_COMPANY = 8;
const LOOKBACK_DAYS = 120;
const USER_AGENT = 'Market Catalyst Backend hello@inc108.com';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/**
 * Session from the SEC acceptance timestamp — see edgar-8k.job.ts for why
 * this reads the HH:MM directly rather than doing TZ math.
 */
function sessionFromAcceptance(acc?: string): 'BMO' | 'AMC' | 'Intraday' | null {
  if (!acc || acc.length < 16) return null;
  const hh = Number(acc.slice(11, 13));
  const mm = Number(acc.slice(14, 16));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const mins = hh * 60 + mm;
  if (mins < 9 * 60 + 30) return 'BMO';
  if (mins >= 16 * 60) return 'AMC';
  return 'Intraday';
}

async function fetchTickerToCik(): Promise<Map<string, string>> {
  const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': USER_AGENT },
  });
  const data = await res.json();
  const map = new Map<string, string>();
  for (const entry of Object.values(data) as any[]) {
    map.set(entry.ticker.toUpperCase(), String(entry.cik_str));
  }
  return map;
}

export interface WireDoc {
  id: string;
  ticker: string;
  companyName: string;
  form: string;
  filingDate: string;
  announceDate: string;
  acceptanceDateTime: string | null;
  items: string | null;
  session: 'BMO' | 'AMC' | 'Intraday' | null;
  isEarnings: boolean;
  description: string;
  url: string;
  updatedAt: string;
}

export interface AnnouncementSeed {
  ticker: string;
  companyName: string;
  announceDate: string;
  session: 'BMO' | 'AMC' | 'Intraday' | null;
  accessionNumber: string;
  url: string;
}

/**
 * Shared live fetch for filings-wire.controller.ts and
 * earnings-announcements.controller.ts — both read from the SAME per-ticker
 * SEC EDGAR submissions call (see edgar-8k.job.ts, the cron analog), so this
 * exists once instead of duplicating the CIK-map + submissions loop in both
 * controllers.
 *
 * SecEdgarService throttles itself to one request every 150ms GLOBALLY
 * (shared across all callers, SEC's own rate-limit guideline) — looping the
 * full `TICKER_UNIVERSE` therefore takes 241 * 150ms = ~36s minimum before
 * any actual network latency, per request. That's above the frontend's 20s
 * fetch timeout; this is a known, accepted tradeoff for a live (no-cache)
 * per-request implementation rather than a bug.
 */
@Injectable()
export class Edgar8kFeedService {
  private readonly logger = new Logger(Edgar8kFeedService.name);

  constructor(private readonly secEdgar: SecEdgarService) {}

  async fetchAll(): Promise<{ wireDocs: WireDoc[]; announcements: AnnouncementSeed[] }> {
    const tickerToCik = await fetchTickerToCik();
    const cutoff = isoDate(addDays(new Date(), -LOOKBACK_DAYS));

    const wireDocs: WireDoc[] = [];
    const announcements: AnnouncementSeed[] = [];

    for (const ticker of TICKER_UNIVERSE) {
      const cik = tickerToCik.get(ticker);
      if (!cik) continue;
      try {
        const { name, recentFilings } = await this.secEdgar.getSubmissions(cik);
        const eightKs = recentFilings
          .filter((f) => f.form === '8-K' && f.filingDate >= cutoff)
          .slice(0, FILINGS_PER_COMPANY);
        for (const f of eightKs) {
          const announceDate = f.reportDate || f.filingDate;
          const session = sessionFromAcceptance(f.acceptanceDateTime);
          const items = f.items ?? '';
          const hasResults = /(^|[^\d])2\.02([^\d]|$)/.test(items);
          const accNoDash = f.accessionNumber.replace(/-/g, '');
          const url = `https://www.sec.gov/Archives/edgar/data/${cik.replace(/\D/g, '')}/${accNoDash}/${f.primaryDocument}`;

          wireDocs.push({
            id: f.accessionNumber,
            ticker,
            companyName: name ?? ticker,
            form: f.form,
            filingDate: f.filingDate,
            announceDate,
            acceptanceDateTime: f.acceptanceDateTime ?? null,
            items: items || null,
            session,
            isEarnings: hasResults,
            description: f.primaryDocDescription ?? '8-K',
            url,
            updatedAt: new Date().toISOString(),
          });

          if (hasResults) {
            announcements.push({
              ticker,
              companyName: name ?? ticker,
              announceDate,
              session,
              accessionNumber: f.accessionNumber,
              url,
            });
          }
        }
      } catch (err) {
        this.logger.error(`Failed syncing 8-K for ${ticker}: ${(err as Error).message}`);
      }
    }

    return { wireDocs, announcements };
  }
}
