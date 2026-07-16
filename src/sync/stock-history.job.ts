import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { SyncMetaService } from '../common/sync-meta.service';
import { TICKER_UNIVERSE } from '../common/ticker-universe';
import { PolygonService } from '../vendors/polygon/polygon.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'stock-history';
const BATCH_SIZE = 60;
const REQUEST_DELAY_MS = 12_500;
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
    private readonly polygon: PolygonService,
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
            await sleep(REQUEST_DELAY_MS);
            continue;
          }
          const bars = await this.polygon.getAggsRange(ticker, from, today);
          if (bars.length > 0) {
            const writeBatch = this.firebase.firestore.batch();
            const col = this.firebase.firestore.collection('ohlcv_bars');
            let lastDate = watermark;
            for (const bar of bars) {
              const barDate = isoDate(new Date(bar.t));
              writeBatch.set(col.doc(`${ticker}_${barDate}`), {
                ticker,
                barDate,
                timespan: 'day',
                open: bar.o,
                high: bar.h,
                low: bar.l,
                close: bar.c,
                volume: bar.v,
                source: 'polygon',
              });
              if (!lastDate || barDate > lastDate)
                lastDate = barDate;
            }
            await writeBatch.commit();
            if (lastDate)
              await this.meta.setWatermark(JOB_NAME, ticker, lastDate);
            barsWritten += bars.length;
            tickersUpdated++;
          }
        } catch (err) {
          this.logger.error(`Failed syncing history for ${ticker}: ${err.message}`);
        }
        await sleep(REQUEST_DELAY_MS);
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
