import { Injectable, Logger } from '@nestjs/common';
import { FirebaseAdminService } from './firebase-admin.provider';
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

  async record(jobName: string, result: SyncResult): Promise<void> {
    const jobMeta = this.registry.getMeta(jobName);
    const now = new Date().toISOString();
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

    try {
      await this.firebase.firestore
        .collection('sync_meta')
        .doc(jobName)
        .set(doc, { merge: true });
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
    await this.firebase.firestore
      .collection('sync_meta')
      .doc(jobName)
      .set({ cursor }, { merge: true });
  }

  async getWatermark(jobName: string, entityKey: string): Promise<string | null> {
    const snap = await this.firebase.firestore
      .collection('sync_watermarks')
      .doc(`${jobName}__${entityKey}`)
      .get();
    return snap.data()?.lastSyncedThrough ?? null;
  }

  async setWatermark(
    jobName: string,
    entityKey: string,
    lastSyncedThrough: string,
  ): Promise<void> {
    await this.firebase.firestore
      .collection('sync_watermarks')
      .doc(`${jobName}__${entityKey}`)
      .set(
        {
          jobName,
          entityKey,
          lastSyncedThrough,
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
  }
}
