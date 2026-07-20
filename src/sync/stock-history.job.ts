import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { batchSetWithCreatedAt, type PendingWrite } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { TICKER_UNIVERSE } from '../common/ticker-universe';
import { MARKET_BARS_ADAPTER, type MarketBarsAdapter } from '../adapters/types';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'stock-history';
const BATCH_SIZE = 60;
const BACKFILL_DAYS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

@Injectable()
export class StockHistoryJob implements OnModuleInit {
  private readonly logger = new Logger(StockHistoryJob.name);

  constructor(
    @Inject(MARKET_BARS_ADAPTER) private readonly bars: MarketBarsAdapter,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['ohlcv_bars'],
      cronExpression: '0 3 * * *',
      timeZone: 'America/New_York',
    });
  }

  @Cron('0 3 * * *', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from({ length: BATCH_SIZE }, (_, i) => TICKER_UNIVERSE[(cursor + i) % TICKER_UNIVERSE.length]);
      const today = isoDate(new Date());
      let barsWritten = 0;
      let tickersUpdated = 0;
      for (const ticker of batch) {
        try {
          const watermark = await this.meta.getWatermark(JOB_NAME, ticker);
          const from = watermark
            ? isoDate(addDays(new Date(watermark), 1))
            : isoDate(addDays(new Date(), -BACKFILL_DAYS));
          if (from > today) {
            await sleep(this.bars.requestDelayMs);
            continue;
          }
          const result = await this.bars.fetchDailyBars(ticker, from, today);
          const bars = result.data;
          if (bars.length > 0) {
            const writes: PendingWrite[] = [];
            const col = this.firebase.firestore.collection('ohlcv_bars');
            let lastDate = watermark;
            for (const bar of bars) {
              const barDate = bar.date;
              writes.push({
                ref: col.doc(`${ticker}_${barDate}`),
                data: {
                  ticker,
                  barDate,
                  timespan: 'day',
                  open: bar.open,
                  high: bar.high,
                  low: bar.low,
                  close: bar.close,
                  volume: bar.volume,
                  source: result.source,
                },
                // merge:false preserves this call site's original plain set().
                // Bars are re-fetched with adjusted=true, so a split rewrites
                // history — an overwrite is what keeps the row internally
                // consistent rather than blending old and new adjustments.
                merge: false,
              });
              if (!lastDate || barDate > lastDate)
                lastDate = barDate;
            }
            await batchSetWithCreatedAt(this.firebase.firestore, writes);
            if (lastDate)
              await this.meta.setWatermark(JOB_NAME, ticker, lastDate);
            barsWritten += bars.length;
            tickersUpdated++;
          }
        } catch (err) {
          this.logger.error(`Failed syncing history for ${ticker}: ${err.message}`);
        }
        await sleep(this.bars.requestDelayMs);
      }
      await this.meta.setCursor(JOB_NAME, (cursor + BATCH_SIZE) % TICKER_UNIVERSE.length);
      await this.meta.record(JOB_NAME, { ok: true, count: barsWritten });
      return { barsWritten, tickersUpdated };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
