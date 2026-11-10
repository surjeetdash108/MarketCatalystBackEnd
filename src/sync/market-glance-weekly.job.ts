import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { MarketGlanceService } from "../live/market-glance.service";

/**
 * Friday-noon "Week at a glance" — builds and stores the current week's market
 * digest on a schedule, so the Live Feed's Weekly Summary tab already has the
 * Friday-noon summary when the first viewer opens it.
 *
 * Before this job the digest was built ONLY on demand (the first viewer of a
 * stale week waited on the model). The Cloud Scheduler entry
 * `sync-market-glance-weekly` (`0 12 * * 5` America/New_York) POSTs
 * /sync/market-glance-weekly/run — the generic, AdminGuard-protected job route
 * in SyncController — which runs this. The work itself lives in
 * MarketGlanceService.rebuildCurrentWeek(); this class is only the trigger.
 *
 * No holiday gate: on a market holiday that falls on Friday (Good Friday) the
 * week still has analyses worth summarising, and an empty week is cached as a
 * legitimate "no activity" digest.
 *
 * Failure semantics: rebuildCurrentWeek() resolves null when nothing was stored
 * (model disabled, or every provider failed/timed out). That is thrown here so
 * the route answers 502 and Cloud Scheduler can retry — silently "succeeding"
 * would leave the tab to fall back to the first-viewer build.
 */

const JOB_NAME = "market-glance-weekly";
/** Fridays 12:00 ET. Informational here — the real trigger is Cloud Scheduler. */
const CRON = "0 12 * * 5";

@Injectable()
export class MarketGlanceWeeklyJob implements OnModuleInit {
  private readonly logger = new Logger(MarketGlanceWeeklyJob.name);

  constructor(
    private readonly glance: MarketGlanceService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["market_weekly_glance"],
      cronExpression: CRON,
      timeZone: "America/New_York",
    });
  }

  async run() {
    try {
      const doc = await this.glance.rebuildCurrentWeek();
      if (!doc) {
        throw new Error(
          "weekly glance was not stored (LLM disabled or all providers failed) — see market-glance logs",
        );
      }
      await this.meta.record(JOB_NAME, { ok: true, count: 1 });
      this.logger.log(
        `weekly glance ${doc.periodKey} built from ${doc.sourceCount} analyses (model=${doc.model || "none"})`,
      );
      return {
        built: true,
        periodKey: doc.periodKey,
        sourceCount: doc.sourceCount,
        generatedAt: doc.generatedAt,
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: (err as Error).message });
      throw err;
    }
  }
}
