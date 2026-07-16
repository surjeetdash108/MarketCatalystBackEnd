import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { chunkedBatchSet } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { FmpService } from '../vendors/fmp/fmp.service';
import { PolygonService } from '../vendors/polygon/polygon.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'dividends';
const LOOKAHEAD_DAYS = 30;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class DividendsJob implements OnModuleInit {
  private readonly logger = new Logger(DividendsJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly fmp: FmpService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['dividends'],
      cronExpression: '20 6 * * *',
      timeZone: 'America/New_York',
    });
  }

  @Cron('20 6 * * *', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const from = isoDate(new Date());
      const to = new Date();
      to.setUTCDate(to.getUTCDate() + LOOKAHEAD_DAYS);
      const toStr = isoDate(to);
      let events;
      let source = 'polygon';
      try {
        events = await this.polygon.getDividendsCalendar(from, toStr);
      } catch (err) {
        this.logger.warn(`Polygon dividends failed, falling back to FMP: ${err.message}`);
        events = await this.fmp.getDividendsCalendar(from, toStr);
        source = 'fmp';
      }
      await chunkedBatchSet(this.firebase.firestore, 'dividends', events.map((e) => ({
        id: e.symbol,
        data: {
          ticker: e.symbol,
          exDividendDate: e.date,
          recordDate: e.recordDate,
          paymentDate: e.paymentDate,
          declarationDate: e.declarationDate,
          dividendAmount: e.dividend,
          yieldPct: e.yield,
          frequency: e.frequency,
          source,
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
