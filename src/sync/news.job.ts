import { Injectable, OnModuleInit } from "@nestjs/common";
import { NewsRefreshService } from "../live/news-refresh.service";
import { SyncRegistry } from "../common/sync-registry.service";

const JOB_NAME = "news";

/**
 * News is NO LONGER SCHEDULED. It is fetched on demand: a request that finds
 * the stored news older than 15 minutes refreshes it in the background
 * (NewsRefreshService.ensureFresh / cache_status). Nothing fetches news while
 * nobody is using the app.
 *
 * This class stays only so an admin can still run "news" by hand from the Jobs
 * tab. A manual run goes through cache_status too: if the news is still fresh,
 * or a request is already refreshing it, it does nothing.
 *
 * Retired triggers (see job-manifest.ts):
 *   - Cloud Scheduler entry `sync-news` (every 10 min). Removing it from the
 *     code does NOT stop it: it must be paused in Google Cloud, AFTER this code
 *     is deployed, or news stops updating on the old code.
 *   - The `news` phase of the 08:00 premarket bundle (premarket-phases.ts).
 * Even if `sync-news` still fires, a run now only fetches when the cache has
 * expired, so it can no longer fetch on top of user requests.
 */
@Injectable()
export class NewsJob implements OnModuleInit {
  constructor(
    private readonly refresher: NewsRefreshService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["news", "news_breaking"],
      cronExpression: "*/15 * * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    return this.refresher.ensureFresh(true);
  }
}
