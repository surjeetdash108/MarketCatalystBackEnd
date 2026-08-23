import { getTickerToCik } from "../common/sec-cik-map.util";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { TICKER_UNIVERSE } from "../common/ticker-universe";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";
import { SyncRegistry } from "../common/sync-registry.service";

const JOB_NAME = "sec-form4";
const BATCH_SIZE = 20;
const FILINGS_PER_COMPANY = 3;
// Form 4 price fields occasionally carry a garbage per-share value (a footnote
// artifact, or a total dollar amount landing in the price field) — e.g. a
// $2,110,482/sh row that fabricates a multi-billion-dollar transaction. No US
// equity trades near this: the priciest (BRK.A) is well under $1M/sh, so any
// per-share price above the ceiling is discarded (null) rather than stored.
const MAX_PLAUSIBLE_SHARE_PRICE = 1_000_000;


@Injectable()
export class SecForm4Job implements OnModuleInit {
  private readonly logger = new Logger(SecForm4Job.name);

  constructor(
    private readonly secEdgar: SecEdgarService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["insider_transactions"],
      cronExpression: "30 1 * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from(
        { length: BATCH_SIZE },
        (_, i) => TICKER_UNIVERSE[(cursor + i) % TICKER_UNIVERSE.length],
      );
      const tickerToCik = await getTickerToCik(
        this.firebase.firestore,
        "Market Catalyst Backend hello@inc108.com",
      );
      const docs = [];
      for (const ticker of batch) {
        const cik = tickerToCik.get(ticker);
        if (!cik) {
          this.logger.warn(
            `No CIK found for ${ticker} — skipping Form 4 lookup`,
          );
          continue;
        }
        try {
          const { recentFilings } = await this.secEdgar.getSubmissions(cik);
          const form4Filings = recentFilings
            .filter((f) => f.form === "4")
            .slice(0, FILINGS_PER_COMPANY);
          for (const filing of form4Filings) {
            const marker = await this.firebase.firestore
              .collection("insider_transactions")
              .doc(`${filing.accessionNumber}_0`)
              .get();
            if (marker.exists) continue;
            const { issuer, owner, transactions } =
              await this.secEdgar.getForm4Transactions(
                cik,
                filing.accessionNumber,
              );
            transactions.forEach((t, i) => {
              const shares =
                Number(t.transactionAmounts?.transactionShares?.value) || 0;
              const rawPrice = Number(
                t.transactionAmounts?.transactionPricePerShare?.value,
              );
              // Keep only a positive, plausible per-share price; anything else
              // (0, blank, NaN, or an implausibly huge garbage value) → null so
              // no fabricated dollar value is derived downstream.
              const price =
                Number.isFinite(rawPrice) &&
                rawPrice > 0 &&
                rawPrice <= MAX_PLAUSIBLE_SHARE_PRICE
                  ? rawPrice
                  : null;
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
                    t.transactionAmounts?.transactionAcquiredDisposedCode
                      ?.value,
                  shares,
                  pricePerShare: price,
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
            `Failed syncing Form 4 for ${ticker}: ${err.message}`,
          );
        }
      }
      await chunkedBatchSet(
        this.firebase.firestore,
        "insider_transactions",
        docs,
      );
      await this.meta.setCursor(
        JOB_NAME,
        (cursor + BATCH_SIZE) % TICKER_UNIVERSE.length,
      );
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      return { count: docs.length };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
