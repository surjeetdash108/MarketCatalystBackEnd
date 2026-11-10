import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { BETA_METHOD } from "../common/monthly-beta.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { activeUniverse } from "../common/ticker-universe";
import { MonthlyBetaService } from "../live/monthly-beta.service";

const JOB_NAME = "beta";
/** stock-history's registry name — its synced range is cleared while a split
 *  re-backfill is pending (corporate-actions.job, BUG-DATA-001). */
const STOCK_HISTORY_JOB = "stock-history";
const CONCURRENCY = Number(process.env.BETA_CONCURRENCY) || 8;
/** Commit as we go, so a run killed part-way keeps the work it finished. */
const FLUSH_EVERY = 200;

/**
 * Owns `companies.beta`: the 5-year MONTHLY beta vs SPY (see
 * common/monthly-beta.util.ts for why it replaced the 1-year daily one, which
 * technical-indicators still publishes as `beta1yDaily`).
 *
 * Runs every weekday as a premarket phase, but a ticker is only recomputed when
 * its `betaAsOf` is behind the newest completed month — so the universe is
 * really computed once a month, while a new listing or a ticker that failed
 * yesterday is picked up on the next run instead of waiting a month.
 *
 * Cost per full recompute: ~61 document reads per ticker (month-end bars by id)
 * plus a Polygon call only for tickers short on stored history.
 */
@Injectable()
export class BetaJob implements OnModuleInit {
  private readonly logger = new Logger(BetaJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly betas: MonthlyBetaService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["companies"],
      cronExpression: "0 8 * * 1-5",
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
        return { written: 0, note: "no active tickers yet" };
      }

      const market = await this.betas.loadMarket();
      const due = await this.tickersDue(universe, market.asOf);
      if (due.length === 0) {
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { written: 0, asOf: market.asOf, note: "all current" };
      }

      let pending: { id: string; data: Record<string, unknown> }[] = [];
      let written = 0;
      let failed = 0;
      let insufficient = 0;
      let fromVendor = 0;
      const flush = async () => {
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        await chunkedBatchSet(this.firebase.firestore, "companies", batch);
        written += batch.length;
      };

      const queue = [...due];
      const worker = async () => {
        for (;;) {
          const ticker = queue.shift();
          if (!ticker) return;
          try {
            const { lastSyncedThrough } = await this.meta.getSyncedRange(
              STOCK_HISTORY_JOB,
              ticker,
            );
            const r = await this.betas.computeFor(ticker, market, {
              historyPending: lastSyncedThrough == null,
            });
            if (r.source === "polygon") fromVendor++;
            if (!r.beta) insufficient++;
            // Written even when null: it replaces the old 1-year daily value
            // and marks the ticker done for the month, so a short-history name
            // is not re-fetched from the vendor every morning.
            pending.push({
              id: ticker,
              data: {
                beta: r.beta?.beta ?? null,
                betaMonths: r.beta?.months ?? 0,
                betaR2: r.beta?.r2 ?? null,
                betaAsOf: r.asOf,
                betaMethod: BETA_METHOD,
                betaSource: r.source,
                betaUpdatedAt: new Date().toISOString(),
              },
            });
            if (pending.length >= FLUSH_EVERY) await flush();
          } catch (err) {
            // Not written, so the next run retries it.
            failed++;
            this.logger.warn(
              `beta failed for ${ticker}: ${(err as Error).message}`,
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker),
      );
      await flush();

      await this.meta.record(JOB_NAME, { ok: true, count: written });
      this.logger.log(
        `beta: wrote ${written}/${due.length} due (${universe.length} active) as of ${market.asOf} — ` +
          `${insufficient} with too little history, ${fromVendor} via Polygon, ${failed} failed`,
      );
      return {
        written,
        due: due.length,
        insufficient,
        fromVendor,
        failed,
        asOf: market.asOf,
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /** Active tickers whose stored monthly beta is behind `asOf`. One projected
   *  read per company doc. */
  private async tickersDue(
    universe: string[],
    asOf: string,
  ): Promise<string[]> {
    const snap = await this.firebase.firestore
      .collection("companies")
      .select("betaAsOf", "betaMethod")
      .get();
    const current = new Set(
      snap.docs
        .filter(
          (d) =>
            d.get("betaAsOf") === asOf && d.get("betaMethod") === BETA_METHOD,
        )
        .map((d) => d.id),
    );
    return universe.filter((t) => !current.has(t));
  }
}
