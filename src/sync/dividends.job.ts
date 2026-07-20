import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { chunkedBatchSet } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { DIVIDENDS_ADAPTER, type DividendsAdapter } from '../adapters/types';
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
    @Inject(DIVIDENDS_ADAPTER) private readonly dividends: DividendsAdapter,
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
      const result = await this.dividends.fetchDividends(from, toStr);
      const events = result.data;
      const source = result.source;
      if (result.warnings.length > 0) {
        this.logger.log(`dividends: ${result.warnings.map((w) => w.code).join(', ')}`);
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
          warnings: result.warnings,
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
