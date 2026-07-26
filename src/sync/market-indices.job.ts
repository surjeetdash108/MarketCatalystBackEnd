import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { batchSetWithCreatedAt, type PendingWrite } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { QUOTE_ADAPTER, type QuoteAdapter } from '../adapters/types';
import { SyncRegistry } from '../common/sync-registry.service';
import { PolygonService } from '../vendors/polygon/polygon.service';

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
    private readonly polygon: PolygonService,
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
      // US10Y is NOT an ETF proxy any more. It used to be TLT — a long-treasury
      // fund that moves INVERSELY to the yield it was labelled as, so a falling
      // 10Y rendered as a falling "10Y Yield" tile when the yield was rising.
      // Polygon's /fed/v1/treasury-yields is authorized on this plan and gives
      // the actual constant-maturity yield, plus the rest of the curve for the
      // Macro screen.
      try {
        const curve = await this.polygon.getTreasuryYields(2);
        const latest = curve[0];
        const prior = curve[1];
        if (latest?.yield10Year != null) {
          const value = latest.yield10Year;
          const pc = prior?.yield10Year ?? null;
          // Yields are quoted in percentage POINTS, so `change` is a basis-point
          // move and `pctChange` is its relative size — not the same number.
          const change = pc == null ? null : Math.round((value - pc) * 1000) / 1000;
          const doc = {
            label: '10Y Yield',
            proxyTicker: null,
            isProxy: false,
            note: 'US Treasury 10-year constant-maturity yield, in percent',
            unit: 'percent',
            value,
            change,
            pctChange:
              pc && pc !== 0 && change != null
                ? Math.round(((value - pc) / pc) * 10000) / 100
                : null,
            open: null,
            prevClose: pc,
            asOfDate: latest.date,
            curve: latest,
            source: 'polygon-fed',
            updatedAt: new Date().toISOString(),
          };
          const curveWrites: PendingWrite[] = [
            { ref: col.doc('US10Y'), data: doc },
            {
              ref: historyCol.doc(`${today}_US10Y`),
              data: { ...doc, asOfDate: today },
              merge: false,
            },
          ];
          await batchSetWithCreatedAt(this.firebase.firestore, curveWrites);
          written++;
        }
      } catch (err) {
        this.logger.error(`Failed fetching treasury yields for US10Y: ${err.message}`);
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
