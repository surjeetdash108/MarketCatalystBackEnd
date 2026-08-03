import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { FirebaseAdminService } from './firebase-admin.provider';

/**
 * Per-user API-usage metering, read by the admin console's `apiCalls` column.
 *
 * Counts accumulate IN MEMORY per instance and flush to Firestore in batches
 * (default every 30s), so:
 *   - a request never blocks on a Firestore write (record() is a Map bump), and
 *   - a busy user costs ~one write per flush window, not one write per call.
 *
 * `api_usage/{uid}.count` is written by the backend Admin SDK only; the browser
 * never touches it (UI -> backend -> Firebase). On a transient flush failure the
 * counts are re-queued rather than dropped. Some in-flight counts can be lost on
 * a hard crash — acceptable for a usage metric, not billing.
 */
@Injectable()
export class ApiUsageService implements OnModuleDestroy {
  private readonly logger = new Logger(ApiUsageService.name);
  private readonly pending = new Map<string, number>();

  constructor(private readonly firebase: FirebaseAdminService) {}

  /** Record one API call by `uid`. In-memory only; never throws, never blocks. */
  record(uid: string): void {
    if (!uid) return;
    this.pending.set(uid, (this.pending.get(uid) ?? 0) + 1);
  }

  @Interval(30_000)
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = new Map(this.pending);
    this.pending.clear();

    const { FieldValue } = await import('firebase-admin/firestore');
    const now = new Date().toISOString();
    await Promise.all(
      [...batch.entries()].map(([uid, count]) =>
        this.firebase.firestore
          .collection('api_usage')
          .doc(uid)
          .set({ count: FieldValue.increment(count), lastCall: now }, { merge: true })
          .catch((err) => {
            // Re-queue so a transient Firestore blip doesn't lose the counts.
            this.pending.set(uid, (this.pending.get(uid) ?? 0) + count);
            this.logger.warn(
              `api_usage flush failed for ${uid}: ${(err as Error).message}`,
            );
          }),
      ),
    );
  }

  /** Flush whatever is buffered on graceful shutdown. */
  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }
}
