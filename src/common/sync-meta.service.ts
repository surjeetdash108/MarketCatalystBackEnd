import { Injectable, Logger } from '@nestjs/common';
import { FirebaseAdminService } from './firebase-admin.provider';
import { setWithCreatedAt } from './firestore-batch.util';
import { SyncRegistry } from './sync-registry.service';

export interface SyncResult {
  ok: boolean;
  count?: number;
  error?: string;
}

@Injectable()
export class SyncMetaService {
  private readonly logger = new Logger(SyncMetaService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly registry: SyncRegistry,
  ) {}

  // Run counters are bucketed by the job's OWN timezone, not the server's, so
  // "today" matches the cron schedule the job actually runs on. An unknown or
  // malformed zone falls back to UTC rather than throwing away the count.
  todayFor(timeZone: string): string {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  async record(jobName: string, result: SyncResult): Promise<void> {
    const jobMeta = this.registry.getMeta(jobName);
    const now = new Date().toISOString();
    const today = this.todayFor(jobMeta?.timeZone ?? 'America/New_York');
    const doc = {
      lastSyncedAt: now,
      lastStatus: result.ok ? 'ok' : 'error',
      lastCount: result.count ?? null,
      ...(result.ok
        ? { lastSuccessAt: now, lastSuccessCount: result.count ?? null }
        : { lastFailedAt: now, lastError: result.error ?? null }),
      ...(jobMeta
        ? {
            collections: jobMeta.collections,
            cronExpression: jobMeta.cronExpression,
            timeZone: jobMeta.timeZone,
          }
        : {}),
    };

    // Counters need a read-then-write (the daily bucket resets when the date
    // rolls over, which FieldValue.increment alone can't express), so this runs
    // in a transaction. Jobs record at most a few times an hour, so the extra
    // read is negligible and contention is effectively zero.
    const ref = this.firebase.firestore.collection('sync_meta').doc(jobName);
    try {
      await this.firebase.firestore.runTransaction(async (tx) => {
        const prev = (await tx.get(ref)).data() ?? {};
        const sameDay = prev.runCountDate === today;
        tx.set(
          ref,
          {
            ...doc,
            runCount: (prev.runCount ?? 0) + 1,
            successCount: (prev.successCount ?? 0) + (result.ok ? 1 : 0),
            errorCount: (prev.errorCount ?? 0) + (result.ok ? 0 : 1),
            runCountDate: today,
            runCountToday: (sameDay ? (prev.runCountToday ?? 0) : 0) + 1,
            // Free here: the transaction has already read the doc, so unlike
            // the batch write paths this needs no extra read to preserve.
            createdAt: prev.createdAt ?? now,
          },
          { merge: true },
        );
      });
    } catch (err) {
      this.logger.error(
        `Failed to record sync_meta for ${jobName}: ${(err as Error).message}`,
      );
    }

    if (!result.ok) {
      this.logger.error(`[${jobName}] sync failed: ${result.error}`);
    } else {
      this.logger.log(`[${jobName}] synced ${result.count ?? 0} docs`);
    }
  }

  async status(jobName: string) {
    const snap = await this.firebase.firestore
      .collection('sync_meta')
      .doc(jobName)
      .get();
    return snap.exists
      ? { job: jobName, ...snap.data() }
      : { job: jobName, lastSyncedAt: null };
  }

  async statusAll(): Promise<Array<{ job: string } & Record<string, unknown>>> {
    const snap = await this.firebase.firestore.collection('sync_meta').get();
    return snap.docs.map((d) => ({ job: d.id, ...d.data() }));
  }

  async getCursor(jobName: string): Promise<number> {
    const snap = await this.firebase.firestore
      .collection('sync_meta')
      .doc(jobName)
      .get();
    return snap.data()?.cursor ?? 0;
  }

  async setCursor(jobName: string, cursor: number): Promise<void> {
    // setCursor can land before the job's first record(), creating the doc, so
    // it stamps createdAt too rather than leaving a doc without one.
    await setWithCreatedAt(
      this.firebase.firestore,
      this.firebase.firestore.collection('sync_meta').doc(jobName),
      { cursor },
    );
  }

  async getWatermark(jobName: string, entityKey: string): Promise<string | null> {
    const snap = await this.firebase.firestore
      .collection('sync_watermarks')
      .doc(`${jobName}__${entityKey}`)
      .get();
    return snap.data()?.lastSyncedThrough ?? null;
  }

  /**
   * Both edges of what has been synced for an entity.
   *
   * `lastSyncedThrough` alone only ever moves FORWARD, so a job that raises its
   * backfill depth can never reach the newly-available older history — the next
   * run just asks for `watermark + 1 day` as usual and the deeper window is
   * silently never fetched. `earliestSyncedFrom` records the other edge so a job
   * can detect the gap and fill backwards. Null means "unknown", which callers
   * should treat as "the deep backfill has not run yet".
   */
  async getSyncedRange(
    jobName: string,
    entityKey: string,
  ): Promise<{ lastSyncedThrough: string | null; earliestSyncedFrom: string | null }> {
    const snap = await this.firebase.firestore
      .collection('sync_watermarks')
      .doc(`${jobName}__${entityKey}`)
      .get();
    const d = snap.data();
    return {
      lastSyncedThrough: d?.lastSyncedThrough ?? null,
      earliestSyncedFrom: d?.earliestSyncedFrom ?? null,
    };
  }

  /** Records how far back history has been fetched for an entity. */
  async setEarliestSynced(
    jobName: string,
    entityKey: string,
    earliestSyncedFrom: string,
  ): Promise<void> {
    await setWithCreatedAt(
      this.firebase.firestore,
      this.firebase.firestore
        .collection('sync_watermarks')
        .doc(`${jobName}__${entityKey}`),
      {
        jobName,
        entityKey,
        earliestSyncedFrom,
        updatedAt: new Date().toISOString(),
      },
    );
  }

  async setWatermark(
    jobName: string,
    entityKey: string,
    lastSyncedThrough: string,
  ): Promise<void> {
    await setWithCreatedAt(
      this.firebase.firestore,
      this.firebase.firestore
        .collection('sync_watermarks')
        .doc(`${jobName}__${entityKey}`),
      {
        jobName,
        entityKey,
        lastSyncedThrough,
        updatedAt: new Date().toISOString(),
      },
    );
  }
}
