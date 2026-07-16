import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { chunkedBatchSet } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { FmpService } from '../vendors/fmp/fmp.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'earnings';
const LOOKAHEAD_DAYS = 30;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class EarningsJob implements OnModuleInit {
  private readonly logger = new Logger(EarningsJob.name);

  constructor(
    private readonly fmp: FmpService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['earnings_events'],
      cronExpression: '0 6 * * *',
      timeZone: 'America/New_York',
    });
  }

  @Cron('0 6 * * *', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const from = isoDate(new Date());
      const to = new Date();
      to.setUTCDate(to.getUTCDate() + LOOKAHEAD_DAYS);
      const events = await this.fmp.getEarningsCalendar(from, isoDate(to));
      await chunkedBatchSet(this.firebase.firestore, 'earnings_events', events.map((e) => ({
        id: `${e.symbol}_${e.date}`,
        data: {
          ticker: e.symbol,
          date: e.date,
          epsEstimate: e.epsEstimated,
          epsActual: e.epsActual,
          revenueEstimate: e.revenueEstimated,
          revenueActual: e.revenueActual,
          updatedAt: new Date().toISOString(),
        },
      })));
      await this.meta.record(JOB_NAME, { ok: true, count: events.length });
      return { count: events.length };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
