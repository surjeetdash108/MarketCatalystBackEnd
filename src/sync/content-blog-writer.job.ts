import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { ContentPipelineService } from "../content-pipeline/content-pipeline.service";

const JOB_NAME = "content-blog-writer";
/** Safety sweep; the normal trigger is the content-pipeline Pub/Sub push. */
const CRON = "*/15 * * * *";

/**
 * Writes queued content-pipeline blog items with Claude, one at a time.
 *
 * Triggered by the content-pipeline topic's push subscription (POST
 * /sync/content-blog-writer/run, OIDC as the scheduler invoker) whenever an
 * admin submits, retries or sends back a blog item, and by a Cloud Scheduler
 * sweep every 15 minutes that catches anything a failed publish left queued.
 * The run is under the per-job lock, so overlapping triggers answer
 * "already-running" and the running pass picks their items up.
 */
@Injectable()
export class ContentBlogWriterJob implements OnModuleInit {
  private readonly logger = new Logger(ContentBlogWriterJob.name);

  constructor(
    private readonly pipeline: ContentPipelineService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["content_items", "blogs"],
      cronExpression: CRON,
      timeZone: "America/New_York",
    });
  }

  async run() {
    try {
      const r = await this.pipeline.processQueue();
      await this.meta.record(JOB_NAME, { ok: true, count: r.written });
      if (r.status !== "idle")
        this.logger.log(`content-blog-writer: ${JSON.stringify(r)}`);
      return r;
    } catch (err) {
      const message = (err as Error).message;
      await this.meta.record(JOB_NAME, { ok: false, error: message });
      throw err;
    }
  }
}
