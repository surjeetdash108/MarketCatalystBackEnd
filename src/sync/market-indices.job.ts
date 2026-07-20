import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { batchSetWithCreatedAt, type PendingWrite } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { QUOTE_ADAPTER, type QuoteAdapter } from '../adapters/types';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'market-indices';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const INDEX_PROXIES = [
  {
    symbol: 'SPX',
    label: 'S&P 500',
    proxyTicker: 'SPY',
    isProxy: true,
    note: 'ETF proxy for the S&P 500 index',
  },
  {
    symbol: 'NDX',
    label: 'Nasdaq',
    proxyTicker: 'QQQ',
    isProxy: true,
    note: 'ETF proxy for the Nasdaq-100 index',
  },
  {
    symbol: 'DJI',
    label: 'Dow',
    proxyTicker: 'DIA',
    isProxy: true,
    note: 'ETF proxy for the Dow Jones index',
  },
  {
    symbol: 'RUT',
    label: 'Russell 2K',
    proxyTicker: 'IWM',
    isProxy: true,
    note: 'ETF proxy for the Russell 2000 index',
  },
  {
    symbol: 'GOLD',
    label: 'Gold',
    proxyTicker: 'GLD',
    isProxy: true,
    note: 'ETF proxy for spot gold',
  },
  {
    symbol: 'WTI',
    label: 'WTI Crude',
    proxyTicker: 'USO',
    isProxy: true,
    note: 'ETF proxy for WTI crude oil',
  },
  {
    symbol: 'DXY',
    label: 'Dollar (DXY)',
    proxyTicker: 'UUP',
    isProxy: true,
    note: 'ETF proxy for the US Dollar Index',
  },
  {
    symbol: 'US10Y',
    label: '10Y Yield',
    proxyTicker: 'TLT',
    isProxy: true,
    note: 'Long-treasury ETF, inverse-correlated with the 10Y yield — NOT the yield itself',
  },
  {
    symbol: 'VIX',
    label: 'VIX',
    proxyTicker: 'VIXY',
    isProxy: true,
    note: 'Decaying VIX futures ETN — directional proxy only, not the spot VIX level',
  },
];

@Injectable()
export class MarketIndicesJob implements OnModuleInit {
  private readonly logger = new Logger(MarketIndicesJob.name);

  constructor(
    @Inject(QUOTE_ADAPTER) private readonly quotes: QuoteAdapter,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['market_indices', 'market_indices_history'],
      cronExpression: '5 18 * * 1-5',
      timeZone: 'America/New_York',
    });
  }

  @Cron('5 18 * * 1-5', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const writes: PendingWrite[] = [];
      const col = this.firebase.firestore.collection('market_indices');
      const historyCol = this.firebase.firestore.collection('market_indices_history');
      const today = isoDate(new Date());
      let written = 0;
      for (const idx of INDEX_PROXIES) {
        try {
          const quoteResult = await this.quotes.fetchQuote(idx.proxyTicker);
          if (!quoteResult) {
            this.logger.warn(`No quote for ${idx.symbol} (${idx.proxyTicker}) from any source — skipping`);
            continue;
          }
          const quote = quoteResult.data;
          const source = quoteResult.source;
          const doc = {
            label: idx.label,
            proxyTicker: idx.proxyTicker,
            isProxy: idx.isProxy,
            note: idx.note ?? null,
            value: quote.c,
            change: quote.d,
            pctChange: quote.dp,
            open: quote.o,
            prevClose: quote.pc,
            source,
            updatedAt: new Date().toISOString(),
          };
          writes.push({ ref: col.doc(idx.symbol), data: doc });
          // merge:false preserves this call site's original plain set() — history
          // rows are a full snapshot, not an accumulation of partial updates.
          writes.push({
            ref: historyCol.doc(`${today}_${idx.symbol}`),
            data: {
              ...doc,
              asOfDate: today,
            },
            merge: false,
          });
          written++;
        } catch (err) {
          this.logger.error(`Failed fetching proxy quote for ${idx.symbol} (${idx.proxyTicker}): ${err.message}`);
        }
      }
      await batchSetWithCreatedAt(this.firebase.firestore, writes);
      await this.meta.record(JOB_NAME, { ok: true, count: written });
      return { written };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
