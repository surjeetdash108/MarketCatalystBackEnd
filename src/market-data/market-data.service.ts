import { Injectable, Logger } from "@nestjs/common";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";

// No cron pre-populates these collections (decision #3a in the UI→backend
// migration plan) — this is what makes "first request pays vendor latency,
// every request after is served from Firestore" actually happen. Matches the
// ~daily cadence the sync jobs themselves run on (COMPANY_TTL_MS/DAILY_TTL_MS
// in ondemand.service.ts use the same 20h window).
const STALE_MS = 20 * 3600_000;

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly registry: SyncRegistry,
    private readonly meta: SyncMetaService,
  ) {}

  /**
   * Runs `jobName` synchronously (via SyncRegistry) if its last successful
   * sync is missing or older than `staleMs` (default STALE_MS, 20h — matches
   * the ~daily cadence most sync jobs run on), then returns. Pass a shorter
   * `staleMs` for a job with its own faster cadence (e.g. `news`, whose cron
   * runs every 30 min) so this doesn't wait 20h to refresh it.
   *
   * Bounded by `maxWaitMs` (default 3000ms) so an on-demand sync job that takes
   * 30+ seconds never hangs the user-facing HTTP request — it returns whatever
   * Firestore currently has while the sync finishes in the background.
   */
  async ensureFresh(
    jobName: string,
    staleMs: number = STALE_MS,
    maxWaitMs: number = 3000,
  ): Promise<void> {
    const status: Record<string, unknown> = await this.meta.status(jobName);
    const lastSuccessAt = (status.lastSuccessAt ??
      status.lastSyncedAt ??
      null) as string | null;
    const age = lastSuccessAt
      ? Date.now() - Date.parse(lastSuccessAt)
      : Infinity;
    if (Number.isFinite(age) && age < staleMs) return;

    if (!this.inflight.has(jobName)) {
      const runner = this.registry.get(jobName);
      if (!runner) {
        this.logger.warn(`ensureFresh: no job registered for "${jobName}"`);
        return;
      }
      const run = runner()
        .catch((err) => {
          this.logger.warn(
            `on-demand run of "${jobName}" failed: ${(err as Error).message}`,
          );
        })
        .finally(() => this.inflight.delete(jobName));
      this.inflight.set(jobName, run);
    }

    const timer = new Promise((resolve) => setTimeout(resolve, maxWaitMs));
    await Promise.race([this.inflight.get(jobName), timer]);
  }
}
