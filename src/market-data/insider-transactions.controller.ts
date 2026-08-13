import { Controller, Get, Header, Logger } from '@nestjs/common';
import { TICKER_UNIVERSE } from '../common/ticker-universe';
import { SecEdgarService } from '../vendors/sec-edgar/sec-edgar.service';

const FILINGS_PER_COMPANY = 3;
const USER_AGENT = 'Market Catalyst Backend hello@inc108.com';

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

/**
 * GET /market-data/insider-transactions — backs the Insider & Institutional
 * screen's live transaction feed (SEC Form 4 filings). Calls SEC EDGAR
 * directly on every request (no Firestore cache, no sync job) — mirrors
 * sec-form4.job.ts's fetch, minus persistence and the skip-if-unchanged
 * marker (nothing is written, so there's no prior state to skip against).
 *
 * SecEdgarService throttles to one request every 150ms GLOBALLY across all
 * callers. This is the heaviest of the converted endpoints: up to 1
 * submissions call + 3 Form 4 calls per ticker, across the full 241-ticker
 * TICKER_UNIVERSE — several minutes in the worst case, well past the
 * frontend's 20s timeout. Accepted tradeoff for a live, no-cache
 * implementation rather than a bug.
 */
@Controller('market-data')
export class InsiderTransactionsController {
  private readonly logger = new Logger(InsiderTransactionsController.name);

  constructor(private readonly secEdgar: SecEdgarService) {}

  @Get('insider-transactions')
  @Header('Cache-Control', 'no-store')
  async insiderTransactions() {
    const tickerToCik = await fetchTickerToCik();
    const docs: Record<string, unknown>[] = [];

    for (const ticker of TICKER_UNIVERSE) {
      const cik = tickerToCik.get(ticker);
      if (!cik) continue;
      try {
        const { recentFilings } = await this.secEdgar.getSubmissions(cik);
        const form4Filings = recentFilings.filter((f) => f.form === '4').slice(0, FILINGS_PER_COMPANY);
        for (const filing of form4Filings) {
          const { issuer, owner, transactions } = await this.secEdgar.getForm4Transactions(
            cik,
            filing.accessionNumber,
          );
          transactions.forEach((t, i) => {
            const shares = Number(t.transactionAmounts?.transactionShares?.value) || 0;
            const price = t.transactionAmounts?.transactionPricePerShare?.value;
            docs.push({
              id: `${filing.accessionNumber}_${i}`,
              ticker: issuer?.ticker ?? ticker,
              issuerName: issuer?.name ?? null,
              ownerName: owner?.name ?? null,
              isOfficer: owner?.isOfficer ?? false,
              officerTitle: owner?.officerTitle ?? null,
              transactionDate: t.transactionDate?.value,
              transactionCode: t.transactionCoding?.transactionCode,
              acquiredOrDisposed: t.transactionAmounts?.transactionAcquiredDisposedCode?.value,
              shares,
              pricePerShare: price ? Number(price) : null,
              sharesOwnedAfter:
                Number(t.postTransactionAmounts?.sharesOwnedFollowingTransaction?.value) || null,
              filingDate: filing.filingDate,
              updatedAt: new Date().toISOString(),
            });
          });
        }
      } catch (err) {
        this.logger.error(`Failed syncing Form 4 for ${ticker}: ${(err as Error).message}`);
      }
    }
    return docs;
  }
}
