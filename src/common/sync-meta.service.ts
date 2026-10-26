import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { CronTime } from "cron";
import { FirebaseAdminService } from "./firebase-admin.provider";
import { setWithCreatedAt } from "./firestore-batch.util";
import { SyncRegistry } from "./sync-registry.service";
import { etDate } from "./market-calendar.util";
import { JOB_MANIFEST } from "./job-manifest";

export interface SyncResult {
  ok: boolean;
  count?: number;
  error?: string;
  /**
   * Firestore documents READ by this run.
   *
   * Reads are the largest line on the bill and nothing attributes them: a
   * 30-day measurement found ~75M reads of which only ~28% could be traced to
   * a specific job, by hand, from bar limits times universe size. Firestore's
   * own metrics carry no collection or caller label, so without this the
   * question "which job costs the money" has no answer and optimisation is
   * guesswork. Jobs that read in bulk should report it.
   */
  docsRead?: number;
}

const STALENESS_JOB = "staleness-check";

/** Allowance for a scheduled run to start and finish before it counts as missed. */
const STALE_GRACE_MS = 30 * 60 * 1000;

/**
 * Stale = two scheduled runs have come and gone (plus a grace for the run
 * itself) since the last success, read off the job's own cron in its own zone.
 *
 * "Older than 2× the shortest gap between runs" flagged every weekday job each
 * Monday morning (Friday's 08:00 success is 71h old against a 48h limit) and
 * every `*\/5 6-7,16-17` job each night, so a real failure looked like noise.
 */
export function isJobStale(
  lastSuccessAt: string | null | undefined,
  cronExpression: string,
  timeZone = "America/New_York",
  now: Date = new Date(),
): boolean {
  if (!lastSuccessAt) return true;
  const lastSuccessMs = new Date(lastSuccessAt).getTime();
  if (isNaN(lastSuccessMs)) return true;
  const missedSince = secondRunAfter(lastSuccessMs, cronExpression, timeZone);
  if (missedSince == null) return now.getTime() - lastSuccessMs > 2 * 24 * 60 * 60 * 1000;
  return now.getTime() > missedSince + STALE_GRACE_MS;
}

/**
 * isJobStale against the schedules that ACTUALLY run the job (job-manifest):
 * a registered cronExpression is documentation nothing reads — stock-history
 * registers "0 3 * * *" but runs in the weekday premarket job, so judging it
 * by its registration flagged it every weekend. A job nothing triggers is
 * never "stale" (there is no run to miss). A job missing from the manifest
 * falls back to its registered cron.
 */
export function isJobStaleFor(
  jobName: string,
  lastSuccessAt: string | null | undefined,
  registeredCron: string,
  timeZone = "America/New_York",
  now: Date = new Date(),
): boolean {
  const entry = JOB_MANIFEST.find((e) => e.name === jobName);
  if (entry && entry.trigger === "none") return false;
  const schedules = entry && entry.schedules.length ? entry.schedules : [registeredCron];
  // Stale once two runs of ANY of its schedules have passed (an intraday entry
  // missing twice is a failure even when the post-close entry is not due yet).
  return schedules.some((cron) => isJobStale(lastSuccessAt, cron, timeZone, now));
}

/** Epoch ms of the second scheduled run after `fromMs`, or null for an unparseable cron. */
export function secondRunAfter(fromMs: number, cronExpression: string, timeZone: string): number | null {
  try {
    const t = new CronTime(cronExpression, timeZone);
    const first = t.getNextDateFrom(new Date(fromMs), timeZone);
    return t.getNextDateFrom(first.toJSDate(), timeZone).toMillis();
  } catch {
    return null;
  }
}

@Injectable()
export class SyncMetaService implements OnModuleInit {
  private readonly logger = new Logger(SyncMetaService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly registry: SyncRegistry,
  ) {}

  /**
   * A job that stops running never calls record(), so it can never flag
   * itself. This sweep reads every registered job's sync_meta and logs an
   * error for each stale one (Cloud Logging alerts on severity ERROR).
   */
  onModuleInit() {
    this.registry.register(
      STALENESS_JOB,
      async () => {
        const rows = await this.checkStaleness();
        const stale = rows.filter((r) => r.isStale).length;
        await this.record(STALENESS_JOB, { ok: true, count: stale });
        return { checked: rows.length, stale };
      },
      { collections: ["sync_meta"], cronExpression: "0 * * * *", timeZone: "America/New_York" },
    );
  }

  isJobStale(
    jobName: string,
    lastSuccessAt: string | null | undefined,
    cronExpression: string,
    timeZone = "America/New_York",
    now: Date = new Date(),
  ): boolean {
    return isJobStaleFor(jobName, lastSuccessAt, cronExpression, timeZone, now);
  }

  // Run counters are bucketed by the job's OWN timezone, not the server's, so
  // "today" matches the cron schedule the job actually runs on. An unknown or
  // malformed zone falls back to UTC rather than throwing away the count.
  todayFor(timeZone: string): string {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    } catch {
      return etDate();
    }
  }

  async record(jobName: string, result: SyncResult): Promise<void> {
    const jobMeta = this.registry.getMeta(jobName);
    const now = new Date().toISOString();
    const today = this.todayFor(jobMeta?.timeZone ?? "America/New_York");
    const doc = {
      lastSyncedAt: now,
      lastStatus: result.ok ? "ok" : "error",
      lastCount: result.count ?? null,
      lastDocsRead: result.docsRead ?? null,
      ...(result.ok
        ? { lastSuccessAt: now, lastSuccessCount: result.count ?? null }
        : { lastFailedAt: now, lastError: result.error ?? null }),
      ...(jobMeta
        ? {
            collections: jobMeta.collections,
            cronExpression: jobMeta.cronExpression,
            timeZone: jobMeta.timeZone,
          }
        : {}),
    };

    // Counters need a read-then-write (the daily bucket resets when the date
    // rolls over, which FieldValue.increment alone can't express), so this runs
    // in a transaction. Jobs record at most a few times an hour, so the extra
    // read is negligible and contention is effectively zero.
    const ref = this.firebase.firestore.collection("sync_meta").doc(jobName);
    try {
      await this.firebase.firestore.runTransaction(async (tx) => {
        const prev = (await tx.get(ref)).data() ?? {};
        const sameDay = prev.runCountDate === today;
        const effectiveLastSuccess = result.ok ? now : (prev.lastSuccessAt ?? null);
        const stale = isJobStaleFor(
          jobName,
          effectiveLastSuccess,
          jobMeta?.cronExpression ?? "0 8 * * 1-5",
          jobMeta?.timeZone ?? "America/New_York",
          new Date(now),
        );
        if (stale) {
          this.logger.error(
            `[Staleness] Alert: Job ${jobName} is stale — two scheduled runs have passed since its last success (${effectiveLastSuccess ?? "never"})`,
          );
        }
        tx.set(
          ref,
          {
            ...doc,
            isStale: stale,
            runCount: (prev.runCount ?? 0) + 1,
            successCount: (prev.successCount ?? 0) + (result.ok ? 1 : 0),
            errorCount: (prev.errorCount ?? 0) + (result.ok ? 0 : 1),
            runCountDate: today,
            runCountToday: (sameDay ? (prev.runCountToday ?? 0) : 0) + 1,
            // Free here: the transaction has already read the doc, so unlike
            // the batch write paths this needs no extra read to preserve.
            createdAt: prev.createdAt ?? now,
          },
          { merge: true },
        );
      });
    } catch (err) {
      this.logger.error(
        `Failed to record sync_meta for ${jobName}: ${(err as Error).message}`,
      );
    }

    if (!result.ok) {
      this.logger.error(`[${jobName}] sync failed: ${result.error}`);
    } else {
      this.logger.log(`[${jobName}] synced ${result.count ?? 0} docs`);
    }
  }

  async status(jobName: string) {
    const snap = await this.firebase.firestore
      .collection("sync_meta")
      .doc(jobName)
      .get();
    return snap.exists
      ? { job: jobName, ...snap.data() }
      : { job: jobName, lastSyncedAt: null };
  }

  async statusAll(): Promise<Array<{ job: string } & Record<string, unknown>>> {
    const snap = await this.firebase.firestore.collection("sync_meta").get();
    return snap.docs.map((d) => ({ job: d.id, ...d.data() }));
  }

  async checkStaleness(now: Date = new Date()): Promise<
    Array<{
      job: string;
      isStale: boolean;
      schedule: string;
      lastSuccessAt: string | null;
      lastStatus: string | null;
    }>
  > {
    const list = this.registry.list();
    const results = [];
    for (const job of list) {
      const snap = await this.firebase.firestore
        .collection("sync_meta")
        .doc(job.name)
        .get();
      const data = snap.data();
      const lastSuccessAt = data?.lastSuccessAt ?? null;
      const stale = isJobStaleFor(job.name, lastSuccessAt, job.cronExpression, job.timeZone, now);
      if (stale) {
        this.logger.error(
          `[Staleness] Alert: Job ${job.name} is stale — two scheduled runs have passed since its last success (${lastSuccessAt ?? "never"})`,
        );
      }
      await this.firebase.firestore
        .collection("sync_meta")
        .doc(job.name)
        .set({ isStale: stale }, { merge: true });
      results.push({
        job: job.name,
        isStale: stale,
        schedule: job.cronExpression,
        lastSuccessAt,
        lastStatus: data?.lastStatus ?? null,
      });
    }
    return results;
  }

  async getCursor(jobName: string): Promise<number> {
    const snap = await this.firebase.firestore
      .collection("sync_meta")
      .doc(jobName)
      .get();
    return snap.data()?.cursor ?? 0;
  }

  async setCursor(jobName: string, cursor: number): Promise<void> {
    // setCursor can land before the job's first record(), creating the doc, so
    // it stamps createdAt too rather than leaving a doc without one.
    await setWithCreatedAt(
      this.firebase.firestore,
      this.firebase.firestore.collection("sync_meta").doc(jobName),
      { cursor },
    );
  }

  /**
   * Both edges of what has been synced for an entity.
   *
   * `lastSyncedThrough` alone only ever moves FORWARD, so a job that raises its
   * backfill depth can never reach the newly-available older history — the next
   * run just asks for `watermark + 1 day` as usual and the deeper window is
   * silently never fetched. `earliestSyncedFrom` records the other edge so a job
   * can detect the gap and fill backwards. Null means "unknown", which callers
   * should treat as "the deep backfill has not run yet".
   */
  async getSyncedRange(
    jobName: string,
    entityKey: string,
  ): Promise<{
    lastSyncedThrough: string | null;
    earliestSyncedFrom: string | null;
  }> {
    const snap = await this.firebase.firestore
      .collection("sync_watermarks")
      .doc(`${jobName}__${entityKey}`)
      .get();
    const d = snap.data();
    return {
      lastSyncedThrough: d?.lastSyncedThrough ?? null,
      earliestSyncedFrom: d?.earliestSyncedFrom ?? null,
    };
  }

  /** Records how far back history has been fetched for an entity. */
  async setEarliestSynced(
    jobName: string,
    entityKey: string,
    earliestSyncedFrom: string,
  ): Promise<void> {
    await setWithCreatedAt(
      this.firebase.firestore,
      this.firebase.firestore
        .collection("sync_watermarks")
        .doc(`${jobName}__${entityKey}`),
      {
        jobName,
        entityKey,
        earliestSyncedFrom,
        updatedAt: new Date().toISOString(),
      },
    );
  }

  async setWatermark(
    jobName: string,
    entityKey: string,
    lastSyncedThrough: string,
  ): Promise<void> {
    await setWithCreatedAt(
      this.firebase.firestore,
      this.firebase.firestore
        .collection("sync_watermarks")
        .doc(`${jobName}__${entityKey}`),
      {
        jobName,
        entityKey,
        lastSyncedThrough,
        updatedAt: new Date().toISOString(),
      },
    );
  }

  /**
   * Wipes BOTH edges of an entity's synced range for a job by deleting its
   * `sync_watermarks/{jobName}__{entityKey}` doc, so the next run sees the
   * entity as never-synced and re-fetches its full window from scratch.
   *
   * Used by corporate-actions.job when a NEW split executes for a ticker
   * (BUG-DATA-001): clearing stock-history's range forces a full adjusted
   * re-backfill that rewrites every stored bar (merge:false) on ONE adjustment
   * basis, instead of leaving pre-split bars on the old basis while the daily
   * forward increment writes new bars on the post-split basis. Deleting a
   * non-existent doc is a harmless no-op.
   */
  async clearSyncedRange(jobName: string, entityKey: string): Promise<void> {
    await this.firebase.firestore
      .collection("sync_watermarks")
      .doc(`${jobName}__${entityKey}`)
      .delete();
  }
}
