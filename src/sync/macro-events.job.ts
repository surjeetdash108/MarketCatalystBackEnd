import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MACRO_SERIES } from '../common/macro-series';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { SyncMetaService } from '../common/sync-meta.service';
import { FredService } from '../vendors/fred/fred.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'macro-events';

@Injectable()
export class MacroEventsJob implements OnModuleInit {
  private readonly logger = new Logger(MacroEventsJob.name);

  constructor(
    private readonly fred: FredService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['macro_events'],
      cronExpression: '10 18 * * 1-5',
      timeZone: 'America/New_York',
    });
  }

  @Cron('10 18 * * 1-5', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const batch = this.firebase.firestore.batch();
      const col = this.firebase.firestore.collection('macro_events');
      let written = 0;
      for (const series of MACRO_SERIES) {
        try {
          const obs = await this.fred.getLatestObservations(series.seriesId, 2);
          const [latest, prior] = obs;
          if (!latest) {
            this.logger.warn(`No observations returned for ${series.name} (${series.seriesId})`);
            continue;
          }
          const actual = latest.value === '.' ? null : Number(latest.value);
          const previous = prior && prior.value !== '.' ? Number(prior.value) : null;
          batch.set(col.doc(series.seriesId), {
            name: series.name,
            seriesId: series.seriesId,
            country: series.country,
            unit: series.unit,
            importance: series.importance,
            eventDate: latest.date,
            actual,
            previous,
            estimate: null,
            source: 'fred',
            updatedAt: new Date().toISOString(),
          }, { merge: true });
          written++;
        } catch (err) {
          this.logger.error(`Failed syncing ${series.name} (${series.seriesId}): ${err.message}`);
        }
      }
      await batch.commit();
      await this.meta.record(JOB_NAME, { ok: true, count: written });
      return { count: written };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
