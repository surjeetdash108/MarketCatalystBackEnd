import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { batchSetWithCreatedAt, type PendingWrite } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { SECTORS_ADAPTER, type SectorsAdapter } from '../adapters/types';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'sectors';

function slug(sector: string): string {
  return sector
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

@Injectable()
export class SectorsJob implements OnModuleInit {
  private readonly logger = new Logger(SectorsJob.name);

  constructor(
    @Inject(SECTORS_ADAPTER) private readonly sectors: SectorsAdapter,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['sectors', 'sectors_history'],
      cronExpression: '0 18 * * 1-5',
      timeZone: 'America/New_York',
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const result = await this.sectors.fetchSectorPerformance();
      const rows = result.data;
      const source = result.source;
      if (result.warnings.length > 0) {
        this.logger.log(`sectors: ${result.warnings.map((w) => w.code).join(', ')}`);
      }
      const writes: PendingWrite[] = [];
      const col = this.firebase.firestore.collection('sectors');
      const historyCol = this.firebase.firestore.collection('sectors_history');
      for (const row of rows) {
        const doc = {
          sector: row.sector,
          exchange: row.exchange,
          pctChange: Math.round(row.averageChange * 100) / 100,
          asOfDate: row.date,
          source,
          warnings: result.warnings,
          updatedAt: new Date().toISOString(),
        };
        writes.push({ ref: col.doc(slug(row.sector)), data: doc });
        // merge:false preserves this call site's original plain set() — history
        // rows are a full snapshot, not an accumulation of partial updates.
        writes.push({ ref: historyCol.doc(`${row.date}_${slug(row.sector)}`), data: doc, merge: false });
      }
      await batchSetWithCreatedAt(this.firebase.firestore, writes);
      await this.meta.record(JOB_NAME, { ok: true, count: rows.length });
      return { count: rows.length };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
