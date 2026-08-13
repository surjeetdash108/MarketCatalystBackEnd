import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CronJob } from "cron";
import { AllSourcesFailedError } from "../adapters/adapter-error";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";

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
        nextRunAt: nextRunAt(job.cronExpression, job.timeZone),
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
  async run(@Param("job") job: string) {
    const runner = this.registry.get(job);
    if (!runner) {
      throw new NotFoundException(
        `Unknown job "${job}". Available: ${this.registry.names().join(", ")}`,
      );
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
