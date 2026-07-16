import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { chunkedBatchSet } from '../common/firestore-batch.util';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { SyncMetaService } from '../common/sync-meta.service';
import { diffGroupedDaily } from '../vendors/polygon/polygon-diff.util';
import { PolygonService } from '../vendors/polygon/polygon.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'market-quotes';

@Injectable()
export class MarketQuotesJob implements OnModuleInit {
  private readonly logger = new Logger(MarketQuotesJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['tickers'],
      cronExpression: '7 18 * * 1-5',
      timeZone: 'America/New_York',
    });
  }

  @Cron('7 18 * * 1-5', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const { date, quotes } = await diffGroupedDaily(this.polygon);
      const docs = quotes.map((q) => ({
        id: q.ticker,
        data: {
          ticker: q.ticker,
          price: q.price,
          pctChange: q.pctChange,
          volume: q.volume,
          asOfDate: q.asOfDate,
          quoteSource: 'polygon',
          quoteUpdatedAt: new Date().toISOString(),
        },
      }));
      await chunkedBatchSet(this.firebase.firestore, 'tickers', docs);
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      return { count: docs.length, asOfDate: date };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
