import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { MoneyFlowService } from "../live/money-flow/money-flow.service";

/**
 * Builds the Money Flow board and saves it to Firestore money_flow/latest, so
 * nobody waits for a build: the live API serves the saved board and the
 * browser reads it directly (a build on request took 42–185 s cold).
 *
 * Cloud Scheduler entry sync-money-flow-snapshot fires every minute 09:00–16:59
 * ET on weekdays (deploy/create-money-flow-snapshot-scheduler.sh). That covers
 * the pre-open board (the last session), the session, and the closing minutes
 * while the final bars and the session's own daily bars arrive; the last
 * build stands overnight and over the weekend. Firing every minute also keeps
 * the worker instance warm, so its caches (constituents, reference, 24 h
 * company details) stay filled and most runs only refresh quotes.
 *
 * Runs inline (not detached) under the per-job lock, so a run that outlasts a
 * minute makes the next tick answer "already-running" instead of piling up.
 */
const JOB_NAME = "money-flow-snapshot";
const CRON = "* 9-16 * * 1-5";

@Injectable()
export class MoneyFlowSnapshotJob implements OnModuleInit {
  private readonly logger = new Logger(MoneyFlowSnapshotJob.name);

  constructor(
    private readonly moneyFlow: MoneyFlowService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["money_flow"],
      cronExpression: CRON,
      timeZone: "America/New_York",
    });
  }

  async run() {
    const started = Date.now();
    try {
      const saved = await this.moneyFlow.rebuildAndSave();
      await this.meta.record(JOB_NAME, { ok: true, count: 1 });
      this.logger.log(
        `money-flow snapshot ${saved.sessionDate}: ${saved.jsonBytes} B json, ${saved.gzBytes} B gz, ${Date.now() - started}ms`,
      );
      return { ok: true, ...saved, ms: Date.now() - started };
    } catch (err) {
      const message = (err as Error).message;
      await this.meta.record(JOB_NAME, { ok: false, error: message });
      throw err;
    }
  }
}
