import { Controller, Get, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { JOB_MANIFEST } from "../common/job-manifest";
import { SyncMetaService } from "../common/sync-meta.service";
import { ApiHealthService } from "./api-health.service";

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
    private readonly meta: SyncMetaService,
  ) {}

  /**
   * Job + scheduler inventory for the admin Monitor.
   *
   * Served from the LIVE service, which does not load SyncModule (APP_ROLE
   * gating in app.module.ts) and so has no SyncRegistry to ask. It does not need
   * one: JOB_MANIFEST is plain data readable from either role, and `sync_meta`
   * is a Firestore collection the live service already reads. That avoids a
   * cross-service call to the worker, which would need a new run.invoker
   * binding — the live service's account is not on the worker's IAM policy.
   *
   * `lastSyncedAt: null` here means the job has genuinely never recorded a run.
   */
  @Get("jobs")
  async jobs() {
    let metaByJob = new Map<string, Record<string, unknown>>();
    let metaError: string | null = null;
    try {
      metaByJob = new Map(
        (await this.meta.statusAll()).map((m) => [m.job, m as Record<string, unknown>]),
      );
    } catch (err) {
      // Report the manifest anyway — knowing WHAT should run and how it is
      // triggered is useful even when the run history is unreadable.
      metaError = (err as Error).message;
    }

    const jobs = JOB_MANIFEST.map((entry) => {
      const m = metaByJob.get(entry.name);
      return {
        name: entry.name,
        trigger: entry.trigger,
        schedules: entry.schedules,
        note: entry.note ?? null,
        lastSyncedAt: (m?.lastSyncedAt as string | null) ?? null,
        lastStatus: (m?.lastStatus as string | null) ?? null,
        lastCount: (m?.lastCount as number | null) ?? null,
        lastError: (m?.lastError as string | null) ?? null,
        lastSuccessAt: (m?.lastSuccessAt as string | null) ?? null,
        lastFailedAt: (m?.lastFailedAt as string | null) ?? null,
        runCount: (m?.runCount as number | null) ?? null,
        errorCount: (m?.errorCount as number | null) ?? null,
      };
    });

    const counts = {
      total: jobs.length,
      scheduler: jobs.filter((j) => j.trigger === "scheduler").length,
      premarket: jobs.filter((j) => j.trigger === "premarket").length,
      none: jobs.filter((j) => j.trigger === "none").length,
      failing: jobs.filter((j) => j.lastStatus === "error").length,
      neverRun: jobs.filter((j) => !j.lastSyncedAt).length,
    };

    return { jobs, counts, metaError, generatedAt: new Date().toISOString() };
  }

  // Path is 'apihealth' (no hyphen), NOT 'api-health': the hyphenated path was
  // poisoned in Firebase Hosting's edge cache with SPA HTML before its rewrite
  // existed, and there is no CLI purge — a fresh path sidesteps the stale cache.
  @Get("apihealth")
  async apiHealth() {
    return this.health.check();
  }
}
