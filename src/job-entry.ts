import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import * as Sentry from "@sentry/node";
import type { Firestore } from "firebase-admin/firestore";
import { AppJobModule } from "./app-job.module";
import { FirebaseAdminService } from "./common/firebase-admin.provider";
import { acquireLock, releaseLock } from "./common/job-lock.util";
import { SyncRegistry } from "./common/sync-registry.service";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? "development",
  enabled: !!process.env.SENTRY_DSN,
  tracesSampleRate: 0,
});

const logger = new Logger("JobEntry");

process.on("unhandledRejection", (reason) => {
  Sentry.captureException(reason);
  logger.error(
    `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});

/**
 * Cloud Run Job entrypoint.
 *
 * Boots a Nest APPLICATION CONTEXT (no HTTP server), runs ONE registered sync
 * job to completion, then exits. This exists so long orchestrations — the
 * premarket bundle runs ~15+ min, past Cloud Run's 900s request timeout — no
 * longer need to run "detached" on an always-on HTTP instance. Running them as a
 * Cloud Run Job lets the worker SERVICE scale to zero (min-instances=0), which is
 * the bulk of the cost saving.
 *
 * The job to run comes from SYNC_JOB (default "premarket"). Any name registered
 * in SyncRegistry works, so auto-purge / retention / a single sync can reuse the
 * same image + entrypoint with a different SYNC_JOB.
 *
 * CONCURRENCY: this process is the unit the scheduler and `gcloud run jobs
 * execute` launch, so it is exactly where a double-fire / manual-overlap can
 * spawn two runs of the same job. Before running we take a Firestore-lease lock
 * keyed on the job name (see common/job-lock.util.ts) and release it in a
 * finally, so a given job never runs concurrently with ITSELF across processes.
 * A held lease -> log and skip this run; a Firestore lock-infra error ->
 * proceed anyway (fail-open, see acquireLock). TTL is JOB_LOCK_TTL_MS.
 */
/** Lease lifetime; must exceed the longest job's runtime (premarket ~15+ min). */
const DEFAULT_JOB_LOCK_TTL_MS = 60 * 60 * 1000; // 60 min

async function main(): Promise<void> {
  const jobName = (process.env.SYNC_JOB ?? "premarket").trim();
  const startedMs = Date.now();
  logger.log(`job-entry starting: "${jobName}"`);

  const app = await NestFactory.createApplicationContext(AppJobModule, {
    logger: ["error", "warn", "log"],
  });
  app.enableShutdownHooks();

  // Unique id for THIS run: prefer Cloud Run's execution/task identifiers so a
  // held lease is traceable to a specific job execution; a random suffix keeps
  // it unique locally and across task retries.
  const ownerId = [
    process.env.CLOUD_RUN_EXECUTION ?? "local",
    process.env.CLOUD_RUN_TASK_INDEX ?? "0",
    randomUUID(),
  ].join(":");
  const ttlMs =
    Number(process.env.JOB_LOCK_TTL_MS) > 0
      ? Number(process.env.JOB_LOCK_TTL_MS)
      : DEFAULT_JOB_LOCK_TTL_MS;

  // Resolve Firestore defensively: if the credential/init is missing, treat it
  // like any other lock-infra failure and run WITHOUT a lock rather than
  // halting the sync (fail-open — see acquireLock docblock).
  let firestore: Firestore | null = null;
  try {
    firestore = app.get(FirebaseAdminService).firestore;
  } catch (err) {
    logger.error(
      `job-entry: Firestore unavailable for job lock; PROCEEDING WITHOUT LOCK ` +
        `(safe default): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const registry = app.get(SyncRegistry);
    const runner = registry.get(jobName);
    if (!runner) {
      throw new Error(
        `Unknown job "${jobName}". Available: ${registry.names().join(", ")}`,
      );
    }

    // acquireLock returns true when Firestore is present and the lease is free
    // OR when the lock infra errored (fail-open). It returns false ONLY when a
    // live lease is held by another run — in which case we skip cleanly.
    const gotLock = firestore
      ? await acquireLock(firestore, jobName, { ttlMs, ownerId })
      : true;
    if (!gotLock) {
      logger.warn(
        `job "${jobName}" is already running elsewhere (live lock held); ` +
          `skipping this run.`,
      );
      return;
    }

    try {
      const result = await runner();
      const secs = Math.round((Date.now() - startedMs) / 1000);
      logger.log(
        `job "${jobName}" completed in ${secs}s: ${JSON.stringify(result)}`,
      );
    } finally {
      if (firestore) await releaseLock(firestore, jobName, ownerId);
    }
  } finally {
    // Flushes buffered metering (ApiUsageService.onModuleDestroy) and releases
    // any provider resources before the process exits.
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    Sentry.captureException(err);
    logger.error(
      `job-entry failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    process.exit(1);
  });
