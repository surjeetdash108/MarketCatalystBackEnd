import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { EPHEMERAL_TARGETS, type EphemeralTarget } from "./auto-purge.config";

/**
 * Nightly auto-purge of stale ephemeral data. Registered with SyncRegistry so
 * it appears in the backend monitor alongside the sync jobs (status + a manual
 * "run" button) and can be triggered via POST /sync/auto-purge/run.
 *
 * See auto-purge.config.ts for what is purged and why `updatedAt` + a
 * latest-relative cutoff (not `createdAt`, not absolute now−12h) are correct.
 */

const JOB_NAME = "auto-purge";
const DELETE_BATCH_SIZE = 500;

export interface AutoPurgeResult {
  collection: string;
  latest: string | null;
  cutoff: string | null;
  matched: number;
  deleted: number;
  dryRun: boolean;
}

@Injectable()
export class AutoPurgeJob implements OnModuleInit {
  private readonly logger = new Logger(AutoPurgeJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: EPHEMERAL_TARGETS.map((t) => t.collection),
      cronExpression: "0 0 * * *",
      timeZone: "America/New_York",
    });
  }

  /** Preview only, never deletes — for the ops UI / a dry check. */
  private get dryRun(): boolean {
    return (
      String(this.config.get("AUTO_PURGE_DRY_RUN", "false"))
        .trim()
        .toLowerCase() === "true"
    );
  }

  /**
   * Gate for this version's "no cron jobs run automatically" milestone — see
   * ENABLE_SCHEDULED_JOBS in .env.example and the matching flag in
   * RetentionService. Cache-warm-up crons come back selectively later.
   */
  private get scheduledJobsEnabled(): boolean {
    return (
      String(this.config.get("ENABLE_SCHEDULED_JOBS", "false"))
        .trim()
        .toLowerCase() === "true"
    );
  }

  /** Midnight ET. */
  @Cron("0 0 * * *", { timeZone: "America/New_York" })
  async scheduled() {
    if (!this.scheduledJobsEnabled) {
      this.logger.log(
        "auto-purge: scheduled run skipped (ENABLE_SCHEDULED_JOBS is not true)",
      );
      return;
    }
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const results: AutoPurgeResult[] = [];
      for (const target of EPHEMERAL_TARGETS) {
        results.push(await this.purgeTarget(target));
      }
      const deleted = results.reduce((a, r) => a + r.deleted, 0);
      const matched = results.reduce((a, r) => a + r.matched, 0);
      this.logger.log(
        `auto-purge ${this.dryRun ? "(DRY-RUN) " : ""}complete: ${matched} stale, ${deleted} deleted across ${results.length} collection(s)`,
      );
      // count = docs deleted (or that would be, in dry-run).
      await this.meta.record(JOB_NAME, {
        ok: true,
        count: this.dryRun ? matched : deleted,
      });
      return { results };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }

  private async purgeTarget(target: EphemeralTarget): Promise<AutoPurgeResult> {
    const col = this.firebase.firestore.collection(target.collection);

    // 1. Fetch the latest write. Nothing to purge if the collection is empty.
    const latestSnap = await col.orderBy(target.field, "desc").limit(1).get();
    if (latestSnap.empty) {
      return {
        collection: target.collection,
        latest: null,
        cutoff: null,
        matched: 0,
        deleted: 0,
        dryRun: this.dryRun,
      };
    }
    const latest = latestSnap.docs[0].get(target.field) as string;
    const latestMs = Date.parse(latest);
    if (Number.isNaN(latestMs)) {
      this.logger.warn(
        `auto-purge: ${target.collection}.${target.field} not a parseable date — skipping`,
      );
      return {
        collection: target.collection,
        latest,
        cutoff: null,
        matched: 0,
        deleted: 0,
        dryRun: this.dryRun,
      };
    }
    // 2. Cutoff relative to the latest write, so the current batch always survives.
    const cutoff = new Date(
      latestMs - target.maxAgeHours * 3_600_000,
    ).toISOString();

    // 3. Count, then (unless dry-run) delete in batches.
    const matched = (
      await col.where(target.field, "<", cutoff).count().get()
    ).data().count;
    if (this.dryRun || matched === 0) {
      return {
        collection: target.collection,
        latest,
        cutoff,
        matched,
        deleted: 0,
        dryRun: this.dryRun,
      };
    }

    let deleted = 0;
    for (;;) {
      const snap = await col
        .where(target.field, "<", cutoff)
        .limit(DELETE_BATCH_SIZE)
        .get();
      if (snap.empty) break;
      const batch = this.firebase.firestore.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.size;
      if (snap.size < DELETE_BATCH_SIZE) break;
    }
    this.logger.log(
      `auto-purge: ${target.collection} removed ${deleted} stale doc(s) older than ${cutoff}`,
    );
    return {
      collection: target.collection,
      latest,
      cutoff,
      matched,
      deleted,
      dryRun: this.dryRun,
    };
  }
}
