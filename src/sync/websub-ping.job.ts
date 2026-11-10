import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Timestamp } from "firebase-admin/firestore";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";

/**
 * Tells the WebSub hub that the public RSS feed has a new post.
 *
 * The website declares a hub in /feed.xml (`<atom:link rel="hub">`). A hub only
 * learns a feed changed when its publisher says so: POST `hub.mode=publish` and
 * `hub.url=<feed>`, and the hub fetches the feed and fans the update out to its
 * subscribers.
 *
 * Posts are written by several processes, some of which exit as soon as they
 * finish (the premarket Cloud Run Job, the Scheduler-driven recap jobs), so a
 * ping fired from the publish path would need a timer that never survives. This
 * is a job on its own schedule instead: it looks for posts that went live since
 * its watermark and pings once if there are any.
 *
 * It deliberately lags a publish by SETTLE_MS. The website serves the feed from
 * a post list it keeps in memory for five minutes (lib/blog/posts.ts), so a ping
 * sent the moment a post goes live makes the hub fetch a feed that does not
 * contain it yet, and the hub files that as "nothing new". By six minutes every
 * instance has refilled its list. That assumes nothing in front of the site
 * caches the feed: its Cache-Control asks the CDN for s-maxage=300, but App
 * Hosting's responses come back `private` today. If that ever changes, raise
 * SETTLE_MS to cover the CDN's five minutes as well.
 *
 * A failed ping leaves the watermark where it was, so the next run retries the
 * same window (plus whatever arrived since).
 *
 * Triggered by Cloud Scheduler (deploy/create-websub-scheduler.sh); a code deploy
 * does not create that entry.
 */

const JOB_NAME = "websub-ping";
const CRON = "*/10 * * * *";

/** A post must have been live this long before it is announced — see above. */
export const SETTLE_MS = 6 * 60_000;
const PING_TIMEOUT_MS = 15_000;

const DEFAULT_HUB_URL = "https://pubsubhubbub.appspot.com/";
/** Must equal the feed's own `<atom:link rel="self">`, or the hub rejects the ping. */
const DEFAULT_FEED_URL = "https://marketcatalyst.ai/feed.xml";

@Injectable()
export class WebSubPingJob implements OnModuleInit {
  private readonly logger = new Logger(WebSubPingJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["sync_meta"],
      cronExpression: CRON,
      timeZone: "America/New_York",
    });
  }

  async run() {
    const settledBefore = Date.now() - SETTLE_MS;
    try {
      const cursor = await this.meta.getCursor(JOB_NAME);
      if (!cursor) {
        // First run: there is no "since". Start the clock here rather than
        // announcing every post the site has ever published.
        await this.meta.setCursor(JOB_NAME, settledBefore);
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { pinged: false, reason: "baseline" };
      }

      // Both bounds are on publishedAt, so this needs no composite index. It is
      // set once, on first publish, so a post cannot reappear in a later window.
      const snap = await this.firebase.firestore
        .collection("posts")
        .where("publishedAt", ">", Timestamp.fromMillis(cursor))
        .where("publishedAt", "<=", Timestamp.fromMillis(settledBefore))
        .select("status")
        .get();
      const fresh = snap.docs.filter((d) => d.get("status") === "published").length;

      if (fresh > 0) await this.ping();

      // Never move the watermark backwards (two runs close together).
      await this.meta.setCursor(JOB_NAME, Math.max(cursor, settledBefore));
      await this.meta.record(JOB_NAME, { ok: true, count: fresh, docsRead: snap.size });
      return { pinged: fresh > 0, fresh };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`WebSub ping failed: ${msg}`);
      await this.meta.record(JOB_NAME, { ok: false, error: msg });
      throw err;
    }
  }

  private async ping(): Promise<void> {
    const hub = process.env.WEBSUB_HUB_URL || DEFAULT_HUB_URL;
    const feed = process.env.WEBSUB_FEED_URL || DEFAULT_FEED_URL;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
      const res = await fetch(hub, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ "hub.mode": "publish", "hub.url": feed }),
        signal: controller.signal,
      });
      // The hub answers 204 on success; any 2xx means it accepted the ping.
      if (!res.ok) throw new Error(`hub ${hub} answered ${res.status} for ${feed}`);
      this.logger.log(`pinged ${hub} for ${feed} (${res.status})`);
    } finally {
      clearTimeout(timer);
    }
  }
}
