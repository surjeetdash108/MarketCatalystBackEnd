import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PubSub, type Topic } from "@google-cloud/pubsub";

export const DEFAULT_CONTENT_TOPIC = "content-pipeline";

/**
 * Publishes "a blog item is waiting" to the content-pipeline Pub/Sub topic.
 * Its push subscription calls the worker's content-blog-writer job, which
 * writes queued blog items one at a time. The message only wakes the writer:
 * the queue itself is content_items in Firestore, so a lost or duplicate
 * message can't lose or double-write an article, and the job's Cloud Scheduler
 * sweep picks up anything a failed publish left behind.
 */
@Injectable()
export class ContentQueueService {
  private readonly logger = new Logger(ContentQueueService.name);
  private topic: Topic | null = null;

  constructor(private readonly config: ConfigService) {}

  private get topicName(): string {
    return (
      (this.config.get<string>("CONTENT_PIPELINE_TOPIC") ?? "").trim() ||
      DEFAULT_CONTENT_TOPIC
    );
  }

  private getTopic(): Topic {
    this.topic ??= new PubSub().topic(this.topicName);
    return this.topic;
  }

  /** Best-effort: returns false (and logs) when the publish fails. */
  async wake(
    itemId: string,
    reason: "submitted" | "retry" | "sent-back" | "next",
  ): Promise<boolean> {
    try {
      await this.getTopic().publishMessage({
        json: { itemId, reason, at: new Date().toISOString() },
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `content-pipeline publish failed for ${itemId} (${reason}): ${(err as Error).message}`,
      );
      return false;
    }
  }
}
