import { Injectable, Logger } from "@nestjs/common";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the `sec-form4` sync job + Firestore cache. Reads EDGAR's
 * market-wide "latest filings" (getcurrent) Form 4 stream in one call, then
 * parses each filing's XML for the actual transactions (issuer/owner/shares/
 * price/code) — the same Form 4 parse the drill-down already uses
 * (SecEdgarService.getForm4Transactions). Shaped to the `InsiderTxDoc` the
 * Insider/Dashboard/Stock screens read.
 *
 * Cost: getcurrent (1 call) + 2 throttled SEC calls per filing (index + XML) at
 * ≥150ms each. Capped at MAX_FILINGS so a live request stays a few seconds; a
 * single unparseable filing is skipped, not fatal. 120s reuse window (Form 4s
 * stream but re-crawling on every view is wasteful) — still no cache/cron.
 */

// getcurrent's type filter is a prefix match ("4" also returns 424B*), so we
// over-fetch and keep only exact Form 4s.
const FEED_COUNT = 100;
const MAX_FILINGS = 30;
const REUSE_MS = 120_000;

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

@Injectable()
export class LiveInsiderTransactionsService {
  private readonly logger = new Logger(LiveInsiderTransactionsService.name);
  private readonly coalescer = new LiveCoalescer(REUSE_MS);

  constructor(private readonly secEdgar: SecEdgarService) {}

  async getInsiderTransactions() {
    return this.coalescer.run("insider-transactions", async () => {
      const latest = await this.secEdgar.fetchLatestFilings("4", FEED_COUNT);
      const form4s = latest
        .filter((f) => f.form === "4" && f.accessionNumber)
        .slice(0, MAX_FILINGS);

      const out: {
        id: string;
        ticker: string;
        issuerName: string | null;
        ownerName: string | null;
        isOfficer: boolean;
        officerTitle: string | null;
        transactionDate: string;
        transactionCode: string;
        acquiredOrDisposed: string;
        shares: number;
        pricePerShare: number | null;
      }[] = [];

      // Sequential: SecEdgarService already enforces a global ≥150ms gap, so
      // firing these in parallel wouldn't speed anything up.
      for (const f of form4s) {
        try {
          const parsed = await this.secEdgar.getForm4Transactions(
            f.cik,
            f.accessionNumber,
          );
          if (!parsed.issuer) continue;
          const ticker = (parsed.issuer.ticker ?? "").toUpperCase();
          if (!ticker) continue; // no traded symbol on the filing — skip

          const rows = parsed.transactions ?? [];
          rows.forEach((t: any, i: number) => {
            const amounts = t?.transactionAmounts ?? {};
            const shares = num(amounts?.transactionShares?.value);
            if (shares == null) return; // holding row / nothing transacted
            out.push({
              id: `${f.accessionNumber}_${i}`,
              ticker,
              issuerName: parsed.issuer?.name ?? null,
              ownerName: parsed.owner?.name ?? null,
              isOfficer: !!parsed.owner?.isOfficer,
              officerTitle: parsed.owner?.officerTitle ?? null,
              transactionDate:
                t?.transactionDate?.value ?? f.filingDate ?? "",
              transactionCode: t?.transactionCoding?.transactionCode ?? "",
              acquiredOrDisposed:
                amounts?.transactionAcquiredDisposedCode?.value ?? "",
              shares,
              pricePerShare: num(amounts?.transactionPricePerShare?.value),
            });
          });
        } catch (err) {
          this.logger.warn(
            `Form 4 parse failed for ${f.cik}/${f.accessionNumber}: ${(err as Error).message}`,
          );
        }
      }

      return out;
    });
  }
}
