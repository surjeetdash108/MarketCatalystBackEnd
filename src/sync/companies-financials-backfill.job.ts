import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { SyncRegistry } from "../common/sync-registry.service";

const JOB_NAME = "companies-financials-backfill";
// Docs scanned per run. The `companies` collection is small (hundreds), so one
// run typically clears the whole backlog; the cap just bounds a single run.
const PAGE_SIZE = 300;
// A doc whose eps came back null (genuine no-financials, or a transient miss)
// is re-attempted at most this often, so legit-null ETFs/ADRs aren't re-hit
// every premarket while newly-reporting names still get picked up.
const RECHECK_MS = 3 * 24 * 3600_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fills `eps` + `peRatio` on `companies/{ticker}` docs that lack them — the
 * gap left because the full `companies` sync only refreshes 60 tickers/run and
 * the on-demand `/live/company` writer (historically) created docs without
 * these fields. This is a CHEAP targeted sweep: one Polygon TTM-EPS call per
 * needy ticker (vs the full profile's ~5), P/E derived against the doc's stored
 * price. Idempotent — a doc with a real numeric eps is skipped; a null-eps doc
 * is retried only after RECHECK_MS. Runs each premarket and goes near-free once
 * the collection is filled.
 */
@Injectable()
export class CompaniesFinancialsBackfillJob implements OnModuleInit {
  private readonly logger = new Logger(CompaniesFinancialsBackfillJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly polygon: PolygonService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["companies"],
      cronExpression: "30 4 * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const snap = await this.firebase.firestore.collection("companies").get();
      const now = Date.now();

      // Needy = no real numeric eps yet, and not attempted within RECHECK_MS.
      const todo = snap.docs
        .filter((d) => {
          const x = d.data();
          if (typeof x.eps === "number") return false;
          const checked =
            typeof x.epsSyncedAt === "string" ? Date.parse(x.epsSyncedAt) : 0;
          return !(checked && now - checked < RECHECK_MS);
        })
        .slice(0, PAGE_SIZE);

      const remainingBefore = snap.docs.filter(
        (d) => typeof d.data().eps !== "number",
      ).length;

      const docs = [];
      let filled = 0;
      for (const d of todo) {
        const ticker = d.id;
        const price = (d.data().price as number | undefined) ?? null;
        let eps: number | null = null;
        let peRatio: number | null = null;
        try {
          eps = await this.polygon.getTtmEps(ticker);
        } catch (err) {
          this.logger.warn(
            `backfill eps failed for ${ticker}: ${(err as Error).message}`,
          );
        }
        if (eps != null && price != null && eps > 0) {
          peRatio = Math.round((price / eps) * 100) / 100;
        }
        if (eps != null) filled++;
        docs.push({
          id: ticker,
          data: {
            eps,
            peRatio,
            epsSyncedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        });
        await sleep(this.polygon.requestDelayMs);
      }

      // merge:true (chunkedBatchSet default) — only touches these fields.
      await chunkedBatchSet(this.firebase.firestore, "companies", docs);
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      return {
        scanned: snap.size,
        attempted: docs.length,
        epsResolved: filled,
        remainingMissingEps: Math.max(0, remainingBefore - filled),
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: (err as Error).message });
      throw err;
    }
  }
}
