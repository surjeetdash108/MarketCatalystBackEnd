import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { activeUniverse } from "../common/ticker-universe";
import { ANALYST_RATINGS_ADAPTER } from "../adapters/types";
import type { AnalystRatingsAdapter } from "../adapters/analyst-ratings.adapter";

const JOB_NAME = "analyst-actions";
// Per-run cursor batch — env-configurable so a backfill can cover the universe
// in a few runs instead of 40/run. Default 40 preserves the original cadence.
const BATCH_SIZE = Number(process.env.ANALYST_BATCH_SIZE) || 40;
/** Small gap between per-ticker calls so a batch never bursts the vendor. */
const DELAY_MS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class AnalystActionsJob implements OnModuleInit {
  private readonly logger = new Logger(AnalystActionsJob.name);

  constructor(
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly firebase: FirebaseAdminService,
    // Optional analyst-ratings vendor (FMP). null when ANALYST_SOURCE=none
    // (default) — the job then stays the historical no-op.
    @Inject(ANALYST_RATINGS_ADAPTER)
    private readonly ratings: AnalystRatingsAdapter | null,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["analyst_actions"],
      cronExpression: "0 6 * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    // No ratings vendor (Polygon has no analyst endpoint) → keep the historical
    // no-op. Existing `analyst_actions` docs are left untouched so the screen
    // keeps its last synced consensus.
    if (!this.ratings) {
      this.logger.warn(
        "analyst-actions: no ratings vendor configured (ANALYST_SOURCE=none) — skipping.",
      );
      await this.meta.record(JOB_NAME, { ok: true, count: 0 });
      return { written: 0 };
    }

    try {
      const universe = await activeUniverse(this.firebase.firestore);
      if (universe.length === 0) {
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { written: 0, note: "no active tickers yet" };
      }

      // Rotate a bounded batch per premarket run (same cursor pattern as
      // financials.job) so per-run vendor calls stay predictable; upserts by
      // ticker, so coverage accumulates across runs.
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from(
        { length: Math.min(BATCH_SIZE, universe.length) },
        (_, i) => universe[(cursor + i) % universe.length],
      );

      const docs: { id: string; data: Record<string, unknown> }[] = [];
      let failed = 0;
      for (const ticker of batch) {
        try {
          const c = await this.ratings.getConsensus(ticker);
          if (c) {
            docs.push({
              id: ticker,
              data: {
                ticker,
                consensus: c.consensus,
                strongBuy: c.strongBuy,
                buy: c.buy,
                hold: c.hold,
                sell: c.sell,
                strongSell: c.strongSell,
                source: this.ratings.sourceName,
                updatedAt: new Date().toISOString(),
              },
            });
          }
        } catch (err) {
          failed++;
          this.logger.warn(
            `analyst consensus failed for ${ticker}: ${err.message}`,
          );
        }
        await sleep(DELAY_MS);
      }

      if (docs.length > 0) {
        await chunkedBatchSet(this.firebase.firestore, "analyst_actions", docs);
      }
      await this.meta.setCursor(
        JOB_NAME,
        (cursor + BATCH_SIZE) % universe.length,
      );
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      this.logger.log(
        `analyst-actions: wrote ${docs.length}/${batch.length} (${this.ratings.sourceName}), ${failed} failed`,
      );
      return { written: docs.length, failed };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
