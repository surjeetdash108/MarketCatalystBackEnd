import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { activeUniverse } from "../common/ticker-universe";
import { ANALYST_RATINGS_ADAPTER } from "../adapters/types";
import type { AnalystRatingsAdapter } from "../adapters/analyst-ratings.adapter";

const JOB_NAME = "analyst-actions";
// Full-universe sweep each run: analyst consensus is ONE cheap FMP call per
// ticker (grades-consensus) and FMP handles the concurrent load, so a single run
// covers the whole universe — no cursor, no multi-night coverage lag. A bounded
// worker pool keeps it fast without bursting the vendor (FmpService also paces).
const CONCURRENCY = Number(process.env.ANALYST_CONCURRENCY) || 8;

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

      // Sweep the ENTIRE universe each run via a bounded worker pool. Consensus
      // is upserted by ticker (merge); a ticker with no consensus this run (null,
      // e.g. an ETF) is skipped so its prior doc is never wiped.
      const docs: { id: string; data: Record<string, unknown> }[] = [];
      let failed = 0;
      const queue = [...universe];
      const worker = async () => {
        for (;;) {
          const ticker = queue.shift();
          if (!ticker) return;
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
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, universe.length) }, worker),
      );

      if (docs.length > 0) {
        await chunkedBatchSet(this.firebase.firestore, "analyst_actions", docs);
      }
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      this.logger.log(
        `analyst-actions: wrote ${docs.length}/${universe.length} (${this.ratings.sourceName}), ${failed} failed`,
      );
      return { written: docs.length, failed };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
