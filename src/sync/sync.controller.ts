import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import * as Sentry from "@sentry/node";
import { CronJob } from "cron";
import type { Response } from "express";
import { AllSourcesFailedError } from "../adapters/adapter-error";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { jobManifest } from "../common/job-manifest";

function errorBody(
  statusCode: number,
  error: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return {
    statusCode,
    error,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function nextRunAt(cronExpression: string, timeZone: string): string | null {
  try {
    const job = CronJob.from({
      cronTime: cronExpression,
      onTick: () => {},
      start: false,
      timeZone,
    });
    return job.nextDate().toJSDate().toISOString();
  } catch {
    return null;
  }
}

import { AdminGuard } from "../common/admin.guard";

@Controller("sync")
export class SyncController {
  private readonly logger = new Logger(SyncController.name);

  /**
   * Jobs whose full run exceeds Cloud Run's request timeout (900s) and so must
   * not be awaited inside the HTTP request. `premarket` is the multi-phase
   * orchestration (market-wide -> per-ticker warm -> recaps); awaiting it inline
   * 504's at 15 min and never reaches the FINAL (recaps) phase. For these we
   * return 202 immediately and let the job finish on the instance — which only
   * works because the worker runs with CPU-always-allocated and min-instances=1,
   * so the event loop keeps getting CPU after the response is sent.
   */
  private static readonly DETACHED_JOBS = new Set(["premarket"]);

  constructor(
    private readonly registry: SyncRegistry,
    private readonly meta: SyncMetaService,
  ) {}

  @Get("jobs")
  async jobs() {
    const registered = this.registry.list();
    let metaByJob = new Map();
    let metaError = null;
    try {
      metaByJob = new Map((await this.meta.statusAll()).map((m) => [m.job, m]));
    } catch (err) {
      metaError = err.message;
      this.logger.warn(
        `sync_meta unavailable — returning registered jobs without run history: ${metaError}`,
      );
    }
    return registered.map((job) => {
      const m = metaByJob.get(job.name);
      const manifest = jobManifest(job.name);
      return {
        name: job.name,
        isRunning: job.isRunning,
        runningSince: job.runningSince,
        lastSyncedAt: m?.lastSyncedAt ?? null,
        lastStatus: m?.lastStatus ?? null,
        lastCount: m?.lastCount ?? null,
        lastError: m?.lastError ?? null,
        lastSuccessAt: m?.lastSuccessAt ?? null,
        lastSuccessCount: m?.lastSuccessCount ?? null,
        lastFailedAt: m?.lastFailedAt ?? null,
        runCount: m?.runCount ?? null,
        successCount: m?.successCount ?? null,
        errorCount: m?.errorCount ?? null,
        // Only meaningful if it's still the same day the counter was written —
        // a stale bucket from yesterday would otherwise read as today's count.
        runCountToday:
          m?.runCountDate === this.meta.todayFor(job.timeZone)
            ? (m?.runCountToday ?? 0)
            : 0,
        collections: job.collections,
        cronExpression: job.cronExpression,
        timeZone: job.timeZone,
        // How this job is ACTUALLY triggered, and the schedule that does it —
        // see common/job-manifest.ts.
        trigger: manifest?.trigger ?? "none",
        schedules: manifest?.schedules ?? [],
        triggerNote: manifest?.note ?? null,
        // Only a job something actually fires gets a next-run time. Deriving it
        // from `cronExpression` alone was fiction: the registry never schedules
        // anything, so jobs with no trigger were still advertising a next run
        // that would never arrive.
        nextRunAt:
          manifest && manifest.trigger !== "none"
            ? nextRunAt(job.cronExpression, job.timeZone)
            : null,
        metaError,
      };
    });
  }

  @Get("status")
  async status() {
    try {
      return await this.meta.statusAll();
    } catch (err) {
      throw new HttpException(
        errorBody(
          HttpStatus.SERVICE_UNAVAILABLE,
          "SERVICE_UNAVAILABLE",
          `Firestore sync_meta read failed: ${err.message}`,
        ),
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Get(":job/status")
  async jobStatus(@Param("job") job: string) {
    try {
      return await this.meta.status(job);
    } catch (err) {
      throw new HttpException(
        errorBody(
          HttpStatus.SERVICE_UNAVAILABLE,
          "SERVICE_UNAVAILABLE",
          `Firestore sync_meta read failed for "${job}": ${err.message}`,
        ),
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @UseGuards(AdminGuard)
  @Post(":job/run")
  async run(
    @Param("job") job: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const runner = this.registry.get(job);
    if (!runner) {
      throw new NotFoundException(
        `Unknown job "${job}". Available: ${this.registry.names().join(", ")}`,
      );
    }

    // Long orchestrations run detached: return 202 now, keep running on the
    // instance. See DETACHED_JOBS. Awaiting them inline is killed at Cloud Run's
    // 900s request timeout before the FINAL phase completes.
    if (SyncController.DETACHED_JOBS.has(job)) {
      const state = this.registry.list().find((j) => j.name === job);
      if (state?.isRunning) {
        res.status(HttpStatus.ACCEPTED);
        return {
          job,
          status: "already-running",
          runningSince: state.runningSince,
        };
      }
      // Fire-and-forget: the caller (Cloud Scheduler) gets a fast 202 and the
      // orchestration continues in the background. Errors are logged + reported
      // to Sentry, never surfaced to the caller (there is no one waiting).
      void runner().then(
        () => this.logger.log(`detached job "${job}" completed`),
        (err: unknown) => {
          Sentry.captureException(err);
          this.logger.error(
            `detached job "${job}" failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
          );
        },
      );
      res.status(HttpStatus.ACCEPTED);
      return { job, status: "started", detached: true };
    }

    try {
      return await runner();
    } catch (err) {
      if (err instanceof AllSourcesFailedError) {
        throw new HttpException(
          errorBody(
            HttpStatus.BAD_GATEWAY,
            "UPSTREAM_VENDOR_ERROR",
            err.message,
            {
              retryable: err.anyRetryable,
              fallbackAttempted: err.attempts.map((a) => ({
                source: a.source,
                error: a.error,
              })),
            },
          ),
          HttpStatus.BAD_GATEWAY,
        );
      }
      throw new HttpException(
        errorBody(
          HttpStatus.BAD_GATEWAY,
          "UPSTREAM_VENDOR_ERROR",
          `Job "${job}" failed: ${err.message}`,
          { retryable: true },
        ),
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  @UseGuards(AdminGuard)
  @Post("run-all")
  async runAll() {
    const results = [];
    for (const name of this.registry.names()) {
      const jobState = this.registry.list().find((j) => j.name === name);
      if (jobState?.isRunning) {
        results.push({ job: name, ok: false, skipped: true });
        continue;
      }
      const runner = this.registry.get(name);
      try {
        const result = await runner();
        const count =
          result && typeof result === "object" && "count" in result
            ? (result.count ?? undefined)
            : undefined;
        results.push({ job: name, ok: true, count });
      } catch (err) {
        results.push({ job: name, ok: false, error: err.message });
      }
    }
    return {
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok && !r.skipped).length,
      skipped: results.filter((r) => r.skipped).length,
      results,
    };
  }
}
