import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import * as Sentry from "@sentry/node";
import { AppJobModule } from "./app-job.module";
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
 */
async function main(): Promise<void> {
  const jobName = (process.env.SYNC_JOB ?? "premarket").trim();
  const startedMs = Date.now();
  logger.log(`job-entry starting: "${jobName}"`);

  const app = await NestFactory.createApplicationContext(AppJobModule, {
    logger: ["error", "warn", "log"],
  });
  app.enableShutdownHooks();

  try {
    const registry = app.get(SyncRegistry);
    const runner = registry.get(jobName);
    if (!runner) {
      throw new Error(
        `Unknown job "${jobName}". Available: ${registry.names().join(", ")}`,
      );
    }
    const result = await runner();
    const secs = Math.round((Date.now() - startedMs) / 1000);
    logger.log(`job "${jobName}" completed in ${secs}s: ${JSON.stringify(result)}`);
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
