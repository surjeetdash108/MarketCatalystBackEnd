import { Injectable, Logger } from "@nestjs/common";
import { TICKER_UNIVERSE } from "../common/ticker-universe";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";

const FILINGS_PER_COMPANY = 3;

async function fetchTickerToCik(userAgent: string) {
  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": userAgent },
  });
  const data = (await res.json()) as Record<string, { ticker: string; cik_str: string | number }>;
  const map = new Map<string, string>();
  for (const entry of Object.values(data)) {
    map.set(entry.ticker.toUpperCase(), String(entry.cik_str));
  }
  return map;
}

@Injectable()
export class SecForm4Job {
  private readonly logger = new Logger(SecForm4Job.name);

  constructor(private readonly secEdgar: SecEdgarService) {}

  /** Build insider-transaction docs for ONE company's recent Form 4 filings. */
  private async processTicker(
    ticker: string,
    cik: string,
  ): Promise<{ id: string; data: Record<string, unknown> }[]> {
    const docs: { id: string; data: Record<string, unknown> }[] = [];
    try {
      const { recentFilings } = await this.secEdgar.getSubmissions(cik);
      const form4Filings = recentFilings
        .filter((f) => f.form === "4")
        .slice(0, FILINGS_PER_COMPANY);
      for (const filing of form4Filings) {
        const { issuer, owner, transactions } =
          await this.secEdgar.getForm4Transactions(cik, filing.accessionNumber);
        transactions.forEach((t, i) => {
          const shares =
            Number(t.transactionAmounts?.transactionShares?.value) || 0;
          const price = t.transactionAmounts?.transactionPricePerShare?.value;
          docs.push({
            id: `${filing.accessionNumber}_${i}`,
            data: {
              ticker: issuer?.ticker ?? ticker,
              issuerName: issuer?.name ?? null,
              ownerName: owner?.name ?? null,
              isOfficer: owner?.isOfficer ?? false,
              officerTitle: owner?.officerTitle ?? null,
              transactionDate: t.transactionDate?.value,
              transactionCode: t.transactionCoding?.transactionCode,
              acquiredOrDisposed:
                t.transactionAmounts?.transactionAcquiredDisposedCode?.value,
              shares,
              pricePerShare: price ? Number(price) : null,
              sharesOwnedAfter:
                Number(
                  t.postTransactionAmounts?.sharesOwnedFollowingTransaction
                    ?.value,
                ) || null,
              filingDate: filing.filingDate,
              updatedAt: new Date().toISOString(),
            },
          });
        });
      }
    } catch (err) {
      this.logger.error(
        `Failed syncing Form 4 for ${ticker}: ${(err as Error).message}`,
      );
    }
    return docs;
  }

  private async sweep(
    tickers: string[],
  ): Promise<{ id: string; data: Record<string, unknown> }[]> {
    const tickerToCik = await fetchTickerToCik(
      "Market Catalyst Backend hello@inc108.com",
    );
    const docs: { id: string; data: Record<string, unknown> }[] = [];
    for (const ticker of tickers) {
      const cik = tickerToCik.get(ticker);
      if (!cik) {
        this.logger.warn(`No CIK found for ${ticker} — skipping Form 4 lookup`);
        continue;
      }
      docs.push(...(await this.processTicker(ticker, cik)));
    }
    return docs;
  }

  /**
   * Live-direct: the insider-transaction feed (`insider_transactions` shape),
   * swept across the FULL ticker universe per request WITHOUT writing Firestore
   * and WITHOUT the marker dedupe read. Backs GET
   * /market-data/insider-transactions. (A full SEC sweep is slow — accepted for
   * a live read that must reproduce the whole collection.)
   */
  async fetchLive(): Promise<Record<string, unknown>[]> {
    const docs = await this.sweep([...TICKER_UNIVERSE]);
    return docs.map((d) => ({ id: d.id, ...d.data }));
  }
}
