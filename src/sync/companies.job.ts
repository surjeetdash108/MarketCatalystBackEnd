import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { AllSourcesFailedError } from "../adapters/adapter-error";
import {
  COMPANY_PROFILE_ADAPTER,
  type CompanyProfileAdapter,
} from "../adapters/types";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { setWithCreatedAt } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { activeUniverse } from "../common/ticker-universe";
import { SyncRegistry } from "../common/sync-registry.service";

const JOB_NAME = "companies";
const BATCH_SIZE = 60;
const DELAY_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class CompaniesJob implements OnModuleInit {
  private readonly logger = new Logger(CompaniesJob.name);

  constructor(
    @Inject(COMPANY_PROFILE_ADAPTER)
    private readonly companyProfile: CompanyProfileAdapter,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["companies"],
      cronExpression: "0 2 * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const universe = await activeUniverse(this.firebase.firestore);
      if (universe.length === 0) {
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { count: 0, note: "no active tickers yet" };
      }
      // Batch never larger than the active universe, so a small
      // universe is fully covered in one premarket run.
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from(
        { length: Math.min(BATCH_SIZE, universe.length) },
        (_, i) => universe[(cursor + i) % universe.length],
      );
      let written = 0;
      const failed = [];
      const col = this.firebase.firestore.collection("companies");
      for (const symbol of batch) {
        try {
          const result = await this.companyProfile.fetchCompany(symbol);
          if (!result) {
            const msg = `No profile found for ${symbol} on ${this.companyProfile.sourceName}`;
            this.logger.warn(msg);
            failed.push({ ticker: symbol, error: msg });
            continue;
          }
          const { data, source, warnings } = result;
          if (warnings.length > 0) {
            this.logger.log(
              `${symbol}: ${warnings.length} warning(s) from ${source} — ${warnings.map((w) => w.code).join(", ")}`,
            );
          }
          // The profile adapter carries these as placeholder nulls, but they are
          // OWNED by other jobs: `beta` by technical-indicators, `volume` by
          // market-quotes. Merge-writing them here would clobber the real values
          // those jobs computed back to null between runs. `averageVolume` and
          // `week52Range` are dead placeholders (nothing reads them; the UI uses
          // avgVolume20/50 and computes the 52-week range client-side). Strip all
          // four so this job writes only the fields it actually owns — no
          // cross-job clobbering, no duplicate ownership.
          const {
            beta: _beta,
            volume: _volume,
            averageVolume: _averageVolume,
            week52Range: _week52Range,
            ...profile
          } = data;
          await setWithCreatedAt(this.firebase.firestore, col.doc(symbol), {
            ...profile,
            source,
            warnings,
            updatedAt: new Date().toISOString(),
          });
          written++;
        } catch (err) {
          if (err instanceof AllSourcesFailedError) {
            this.logger.error(
              `${symbol}: every configured source failed — ${err.attempts.map((a) => `${a.source}: ${a.error}`).join(" | ")}`,
            );
            failed.push({ ticker: symbol, error: err.message });
          } else {
            this.logger.error(`Failed syncing ${symbol}: ${err.message}`);
            failed.push({ ticker: symbol, error: err.message });
          }
        }
        await sleep(DELAY_MS);
      }
      await this.meta.setCursor(
        JOB_NAME,
        (cursor + BATCH_SIZE) % universe.length,
      );
      await this.meta.record(JOB_NAME, {
        ok: true,
        count: written,
        ...(failed.length > 0
          ? {
              error: `${failed.length}/${batch.length} tickers failed: ${failed.map((f) => f.ticker).join(", ")}`,
            }
          : {}),
      });
      return {
        written,
        failed,
        cursorAdvancedTo: (cursor + BATCH_SIZE) % universe.length,
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
