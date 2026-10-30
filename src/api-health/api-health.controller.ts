import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { ApiHealthService } from "./api-health.service";
import { JobsAdminService, type RunRequest } from "./jobs-admin.service";
import { ScreenApiService } from "./screen-api.service";

/** Admin responses carry internal detail; keep them out of every cache. */
const NO_STORE = "private, no-store";

/**
 * Admin API-health surface. Behind AdminGuard, so only the admin (with a
 * verified Firebase token, since the public live service runs
 * ADMIN_GUARD_TRUST_IAM=false) can enumerate and probe the API.
 */
@UseGuards(AdminGuard)
@Controller("api/admin")
export class ApiHealthController {
  constructor(
    private readonly health: ApiHealthService,
    private readonly jobsAdmin: JobsAdminService,
    private readonly screenApis: ScreenApiService,
  ) {}

  /**
   * Job + scheduler inventory for the admin Jobs tab.
   *
   * Served from the LIVE service, which does not load SyncModule (APP_ROLE
   * gating in app.module.ts) and so has no SyncRegistry to ask. It does not need
   * one: JOB_MANIFEST is plain data readable from either role, and `sync_meta`,
   * `job_locks` and `admin_job_runs` are Firestore collections the live service
   * already reads. That avoids a cross-service call to the worker.
   *
   * `lastSyncedAt: null` here means the job has genuinely never recorded a run.
   */
  @Get("jobs")
  @Header("Cache-Control", NO_STORE)
  jobs() {
    return this.jobsAdmin.inventory();
  }

  /** Recent manual runs, newest first — the audit trail and the live progress. */
  @Get("jobs/runs")
  @Header("Cache-Control", NO_STORE)
  async jobRuns(@Query("limit") limit?: string) {
    try {
      return {
        runs: await this.jobsAdmin.recentRuns(Number(limit)),
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          error: "SERVICE_UNAVAILABLE",
          code: "RUNS_UNAVAILABLE",
          message: `Could not read manual runs: ${(err as Error).message}`,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Run a job now. Asynchronous by necessity: the browser's request reaches
   * this service through a Firebase Hosting rewrite that gives up after 60 s,
   * and a job can run for an hour. This returns 202 as soon as the run is
   * started and recorded; the Jobs tab then polls GET jobs/runs.
   */
  @Post("jobs/:name/run")
  @HttpCode(HttpStatus.ACCEPTED)
  @Header("Cache-Control", NO_STORE)
  runJob(
    @Param("name") name: string,
    @Body() body: RunRequest | undefined,
    @Req() req: { adminEmail?: string },
  ) {
    // AdminGuard sets adminEmail from a verified Firebase token. A caller that
    // got in on the IAM-trust path (worker only) has no email to record.
    return this.jobsAdmin.requestRun(name, req.adminEmail ?? "iam-caller", body ?? {});
  }

  /**
   * The screen -> API -> status catalogue (screen-api.registry.ts) joined with
   * what this service can say about each API. `?fresh=1` re-runs the probe
   * instead of reusing one from the last minute.
   */
  @Get("screen-apis")
  @Header("Cache-Control", NO_STORE)
  screenApisReport(@Query("fresh") fresh?: string) {
    return this.screenApis.report({ fresh: fresh === "1" || fresh === "true" });
  }

  // Path is 'apihealth' (no hyphen), NOT 'api-health': the hyphenated path was
  // poisoned in Firebase Hosting's edge cache with SPA HTML before its rewrite
  // existed, and there is no CLI purge — a fresh path sidesteps the stale cache.
  @Get("apihealth")
  async apiHealth() {
    return this.health.check();
  }
}
