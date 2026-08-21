import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { activeUniverse } from "../common/ticker-universe";

const JOB_NAME = "company-quotes";

/**
 * Keeps `companies.price` / `pctChange` CURRENT for the WHOLE universe.
 *
 * WHY THIS EXISTS
 * `companies.job` is a deep per-ticker profile sweep (peers, dividends, TTM EPS,
 * sector…), so it is deliberately slow: BATCH_SIZE=60 once a day against a ~570
 * name universe — a full cycle takes ~9.5 DAYS. Nothing else refreshed the quote
 * fields on `companies` intraday (`market-quotes.job` writes the separate
 * `tickers` collection), and the on-demand path only refreshes a ticker when a
 * user actually opens it. The result: every screen reading `companies.pctChange`
 * — heatmap, screener, movers, themes — showed today's move for a handful of
 * recently-viewed names and a random past day's move for everything else, while
 * the stock drawer (which polls /live/quotes) showed the real number. Same
 * ticker, two different values, which is exactly what users reported.
 *
 * This job closes that gap cheaply: the universal-snapshot endpoint returns 250
 * tickers per call, so the entire universe is ~3 calls per run.
 *
 * It writes ONLY the quote fields (merge:true), so it never clobbers the profile
 * fields companies.job owns, the technicals technical-indicators.job owns, or
 * `volume`, which belongs to the quotes path.
 *
 * Source is `getUniversalSnapshot` — the SAME vendor call behind /live/quotes —
 * so the heatmap tile and the stock drawer now agree by construction rather than
 * by luck.
 */
const SNAPSHOT_CHUNK = 250;

@Injectable()
export class CompanyQuotesJob implements OnModuleInit {
  private readonly logger = new Logger(CompanyQuotesJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["companies"],
      // Every 5 minutes across extended trading (04:00–20:00 ET, weekdays).
      // Outside that window quotes don't move, so the last run's close stands.
      cronExpression: "*/5 4-20 * * 1-5",
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
        this.logger.warn("company-quotes: empty universe — nothing to refresh");
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { count: 0 };
      }

      const now = new Date().toISOString();
      const docs: Array<{ id: string; data: Record<string, unknown> }> = [];
      let missing = 0;

      for (let i = 0; i < universe.length; i += SNAPSHOT_CHUNK) {
        const chunk = universe.slice(i, i + SNAPSHOT_CHUNK);
        const snaps = await this.polygon
          .getUniversalSnapshot(chunk)
          .catch((err) => {
            // One bad chunk must not lose the whole run — the other chunks
            // still refresh, and the next run retries this one.
            this.logger.warn(
              `company-quotes: snapshot chunk ${i}-${i + chunk.length} failed: ${err.message}`,
            );
            return [];
          });
        const seen = new Set<string>();
        for (const s of snaps) {
          if (!s.ticker || s.price == null) continue;
          seen.add(s.ticker);
          docs.push({
            id: s.ticker,
            data: {
              price: s.price,
              pctChange: s.changePercent ?? null,
              prevClose: s.previousClose ?? null,
              quoteUpdatedAt: now,
              updatedAt: now,
            },
          });
        }
        missing += chunk.length - seen.size;
      }

      // Data-loss guard: a non-throwing empty upstream would otherwise record a
      // "successful" run that refreshed nothing, masking a broken vendor.
      if (docs.length === 0) {
        this.logger.warn(
          `company-quotes: 0 of ${universe.length} tickers returned a quote — skipping write`,
        );
        await this.meta.record(JOB_NAME, {
          ok: false,
          error: "snapshot returned no quotes for any ticker",
        });
        return { count: 0 };
      }

      await chunkedBatchSet(this.firebase.firestore, "companies", docs);
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      this.logger.log(
        `company-quotes: refreshed ${docs.length}/${universe.length} quotes` +
          (missing > 0 ? ` (${missing} without a snapshot)` : ""),
      );
      return { count: docs.length, missing };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
