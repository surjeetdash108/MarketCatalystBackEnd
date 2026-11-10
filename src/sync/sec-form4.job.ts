import { getTickerToCik, SEC_USER_AGENT_MISSING } from "../common/sec-cik-map.util";
import { form4InsiderRows } from "../common/insider-rows.util";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { TICKER_UNIVERSE, activeUniverse } from "../common/ticker-universe";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";
import { SyncRegistry } from "../common/sync-registry.service";

const JOB_NAME = "sec-form4";
const BATCH_SIZE = 20;
const FILINGS_PER_COMPANY = 3;


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
      // SEC requires an identified User-Agent; without SEC_USER_AGENT the run
      // is skipped (logged + recorded as a failure) and sec.gov is not called.
      if (!this.secEdgar.getUserAgent()) {
        this.logger.error(SEC_USER_AGENT_MISSING);
        throw new Error(SEC_USER_AGENT_MISSING);
      }
      const live = await activeUniverse(this.firebase.firestore);
      const universe = live.length > 0 ? live : TICKER_UNIVERSE;
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from(
        { length: BATCH_SIZE },
        (_, i) => universe[(cursor + i) % universe.length],
      );
      const tickerToCik = await getTickerToCik(
        this.firebase.firestore,
        this.secEdgar.getUserAgent(),
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
            const parsed = await this.secEdgar.getForm4Transactions(
              cik,
              filing.accessionNumber,
            );
            const updatedAt = new Date().toISOString();
            for (const { id, ...row } of form4InsiderRows(
              ticker,
              filing.accessionNumber,
              filing.filingDate,
              parsed,
            )) {
              docs.push({ id, data: { ...row, updatedAt } });
            }
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
        (cursor + BATCH_SIZE) % universe.length,
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
