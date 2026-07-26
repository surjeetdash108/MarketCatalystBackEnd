import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { chunkedBatchSet } from '../common/firestore-batch.util';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { SyncMetaService } from '../common/sync-meta.service';
import { TICKER_UNIVERSE_ADAPTER, type TickerUniverseAdapter } from '../adapters/types';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'ticker-universe';

@Injectable()
export class TickerUniverseJob implements OnModuleInit {
  private readonly logger = new Logger(TickerUniverseJob.name);

  constructor(
    @Inject(TICKER_UNIVERSE_ADAPTER) private readonly universe: TickerUniverseAdapter,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['tickers'],
      cronExpression: '0 3 * * 0',
      timeZone: 'America/New_York',
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const result = await this.universe.fetchAllTickers(true);
      const tickers = result.data;
      if (tickers.length === 0) {
        throw new Error(`${result.source} returned zero tickers — check the API key / plan access to the reference-tickers endpoint`);
      }
      const docs = tickers
        .map((t) => ({
          id: t.ticker,
          data: {
            ticker: t.ticker,
            name: t.name,
            nameLower: t.name ? t.name.toLowerCase() : null,
            searchTokens: t.name
              ? Array.from(new Set([
                ...t.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
                t.ticker.toLowerCase(),
              ]))
              : [t.ticker.toLowerCase()],
            market: t.market,
            locale: t.locale,
            primaryExchange: t.primaryExchange,
            type: t.type,
            active: t.active,
            currencyName: t.currencyName,
            cik: t.cik,
            compositeFigi: t.compositeFigi,
            shareClassFigi: t.shareClassFigi,
            source: result.source,
            updatedAt: new Date().toISOString(),
          },
        }));
      await chunkedBatchSet(this.firebase.firestore, 'tickers', docs);
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      return { count: docs.length };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
