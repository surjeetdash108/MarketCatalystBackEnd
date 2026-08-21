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
// A ticker must be missing from the vendor for this long before it is flagged
// delisted — one bad response should never retire a live company.
const DELIST_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
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
            // The vendor has no reference row for this ticker. `fetchJson`
            // THROWS on a transient/5xx error, so reaching here means a genuine
            // NOT_FOUND — a delisted, acquired or renamed name (a live audit
            // found CYBR/WBA/ZI/BOBJ still serving frozen prices as if current,
            // e.g. CYBR at $420 long after the acquisition closed).
            //
            // Still not delisted on a single miss: stamp `missingSince` and only
            // flag once it has persisted, so one malformed 200 can't retire a
            // live company. Flagged rather than deleted — reversible, auditable,
            // and the doc's history survives if the ticker comes back.
            const now = Date.now();
            const prior = await col.doc(symbol).get();
            const since = (prior.get("missingSince") as string | undefined) ?? null;
            const sinceMs = since ? Date.parse(since) : NaN;
            const persisted =
              Number.isFinite(sinceMs) && now - sinceMs >= DELIST_GRACE_MS;
            await col.doc(symbol).set(
              {
                missingSince: since ?? new Date(now).toISOString(),
                ...(persisted
                  ? { delisted: true, delistedAt: new Date(now).toISOString() }
                  : {}),
              },
              { merge: true },
            );
            const msg = `No profile found for ${symbol} on ${this.companyProfile.sourceName}${persisted ? " — flagged delisted" : " — first miss, watching"}`;
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
          // avgVolume20/50 and computes the 52-week range client-side).
          // `eps`/`peRatio` are stripped too: the adapter derives them from
          // Polygon GAAP TTM, but fundamentals-growth.job and the on-demand path
          // both write the FMP NON-GAAP (NASDAQ/IBD) basis. Writing GAAP here made
          // P/E flip basis depending on which writer ran last — so leave EPS to
          // the non-GAAP owners. Strip all six so this job writes only fields it
          // owns — no cross-job clobbering, no duplicate ownership, no basis flip.
          const {
            beta: _beta,
            volume: _volume,
            averageVolume: _averageVolume,
            week52Range: _week52Range,
            eps: _eps,
            peRatio: _peRatio,
            ...profile
          } = data;
          await setWithCreatedAt(this.firebase.firestore, col.doc(symbol), {
            ...profile,
            source,
            warnings,
            // Resolved again — clear any delisted/missing flags so a ticker that
            // returns (or a false positive) recovers on its own.
            missingSince: null,
            delisted: false,
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
