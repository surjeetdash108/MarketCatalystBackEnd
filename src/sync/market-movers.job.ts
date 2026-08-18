import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { AllSourcesFailedError } from "../adapters/adapter-error";
import {
  MOVERS_ADAPTER,
  MOVER_ENRICHMENT_ADAPTER,
  type MoverEnrichmentAdapter,
  type MoversAdapter,
} from "../adapters/types";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  type PendingWrite,
} from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";

const JOB_NAME = "market-movers";
const TOP_N = 100;
const DELAY_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class MarketMoversJob implements OnModuleInit {
  private readonly logger = new Logger(MarketMoversJob.name);

  constructor(
    @Inject(MOVERS_ADAPTER) private readonly movers: MoversAdapter,
    @Inject(MOVER_ENRICHMENT_ADAPTER)
    private readonly enrichment: MoverEnrichmentAdapter,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["market_movers", "market_movers_history"],
      cronExpression: "0 18 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const moversResult = await this.movers.fetchTopMovers(TOP_N);
      const { date, gainers, losers } = moversResult.data;
      const topMovers = [...gainers, ...losers];
      if (moversResult.warnings.length > 0) {
        this.logger.warn(
          `market-movers: ${moversResult.warnings.map((w) => w.message).join(" | ")}`,
        );
      }
      const enrichmentByTicker = new Map();
      for (const m of topMovers) {
        try {
          const enriched = await this.enrichment.enrichTicker(m.ticker);
          if (enriched) {
            enrichmentByTicker.set(m.ticker, {
              value: enriched.data,
              warnings: enriched.warnings,
            });
          } else {
            enrichmentByTicker.set(m.ticker, {
              value: null,
              warnings: [
                {
                  code: "SUB_REQUEST_FAILED",
                  field: "name,sector,cap",
                  message: `${this.enrichment.sourceName} found no profile for ${m.ticker}.`,
                },
              ],
            });
          }
        } catch (err) {
          if (err instanceof AllSourcesFailedError) {
            this.logger.warn(
              `Enrichment failed for mover ${m.ticker}: every source failed — ${err.attempts.map((a) => `${a.source}: ${a.error}`).join(" | ")}`,
            );
            enrichmentByTicker.set(m.ticker, {
              value: null,
              warnings: [
                {
                  code: "SUB_REQUEST_FAILED",
                  field: "name,sector,cap",
                  message: err.message,
                },
              ],
            });
          } else {
            throw err;
          }
        }
        await sleep(DELAY_MS);
      }
      const writes: PendingWrite[] = [];
      const col = this.firebase.firestore.collection("market_movers");
      const historyCol = this.firebase.firestore.collection(
        "market_movers_history",
      );
      let enrichmentFailures = 0;
      const writeMover = (m, direction) => {
        const enriched = enrichmentByTicker.get(m.ticker);
        const warnings = [
          ...moversResult.warnings,
          ...(enriched?.warnings ?? []),
        ];
        if (enriched?.value == null) enrichmentFailures++;
        const doc = {
          ...m,
          ...enriched?.value,
          direction,
          source: this.movers.sourceName,
          warnings,
          updatedAt: new Date().toISOString(),
        };
        writes.push({ ref: col.doc(`${direction}_${m.ticker}`), data: doc });
        writes.push({
          ref: historyCol.doc(`${date}_${direction}_${m.ticker}`),
          data: doc,
        });
      };
      gainers.forEach((g) => writeMover(g, "gainer"));
      losers.forEach((l) => writeMover(l, "loser"));
      await batchSetWithCreatedAt(this.firebase.firestore, writes);

      // Full refresh of the CURRENT board: `market_movers` is keyed by
      // `${direction}_${ticker}`, and the top tickers change every run, so
      // without this the collection accumulates every past run's movers — old
      // pre-quarantine extremes (e.g. a stale +600%) then headline the board.
      // Only this run's ~40 rows survive. (market_movers_history is meant to
      // accumulate, so it is deliberately left alone.)
      const keepIds = new Set([
        ...gainers.map((g) => `gainer_${g.ticker}`),
        ...losers.map((l) => `loser_${l.ticker}`),
      ]);
      // Data-loss guard: if the movers fetch returned no gainers AND no losers,
      // the keep-set is empty and the delete-pass below would wipe the entire
      // board — the wrong response to a non-throwing empty vendor response (a
      // Polygon soft error). Skip the delete and warn; a genuinely-empty run is
      // a no-op, never a wipe.
      if (keepIds.size === 0) {
        this.logger.warn(
          "market-movers: refresh returned 0 rows — skipping delete-pass to avoid wiping collection market_movers",
        );
      } else {
        const stale = (await col.listDocuments()).filter(
          (ref) => !keepIds.has(ref.id),
        );
        for (let i = 0; i < stale.length; i += 400) {
          const batch = this.firebase.firestore.batch();
          for (const ref of stale.slice(i, i + 400)) batch.delete(ref);
          await batch.commit();
        }
      }
      await this.meta.record(JOB_NAME, {
        ok: true,
        count: gainers.length + losers.length,
        ...(enrichmentFailures > 0
          ? {
              error: `${enrichmentFailures}/${topMovers.length} movers missing name/sector/cap enrichment`,
            }
          : {}),
      });
      return {
        gainers: gainers.length,
        losers: losers.length,
        asOfDate: date,
        enrichmentFailures,
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
