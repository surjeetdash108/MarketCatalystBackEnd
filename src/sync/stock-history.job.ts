import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { batchSetWithCreatedAt, type PendingWrite } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { TICKER_UNIVERSE } from '../common/ticker-universe';
import { MARKET_BARS_ADAPTER, type MarketBarsAdapter } from '../adapters/types';
import { SyncRegistry } from '../common/sync-registry.service';
import { planHistoryFloor } from '../vendors/polygon/polygon.service';

const JOB_NAME = 'stock-history';
const BATCH_SIZE = 60;

/**
 * First-run backfill depth. Was 300 days, which capped the chart at 1Y and left
 * the 5Y timeframe rendering a synthetic series — recorded in the delivery plan
 * as needing a plan upgrade. It does not: the Starter plan serves a five-year
 * rolling window (probed 2026-07-21), so the only thing standing between the app
 * and a real 5Y chart was this constant.
 *
 * Requests that reach past the plan's edge fail wholesale with NOT_AUTHORIZED
 * rather than returning a truncated series, so `from` is clamped to
 * planHistoryFloor() below instead of being allowed to run off the end.
 */
const BACKFILL_DAYS = 365 * 5;
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
      const floor = planHistoryFloor();
      let barsWritten = 0;
      let tickersUpdated = 0;
      for (const ticker of batch) {
        try {
          const { lastSyncedThrough: watermark, earliestSyncedFrom } =
            await this.meta.getSyncedRange(JOB_NAME, ticker);

          // Two windows, because history has to grow in BOTH directions.
          //
          // Forward is the ordinary daily increment. Backward exists because
          // raising BACKFILL_DAYS does nothing on its own: a ticker that already
          // has a watermark only ever asks for `watermark + 1 day`, so the newly
          // available older history would never be fetched and the 5Y chart would
          // stay synthetic forever. `earliestSyncedFrom` records how far back we
          // have actually reached; when it is null the deep backfill has not run
          // for this ticker yet.
          const forwardFrom = watermark
            ? isoDate(addDays(new Date(watermark), 1))
            : isoDate(addDays(new Date(), -BACKFILL_DAYS));
          // Never ask for more history than the plan sells. Polygon rejects the
          // WHOLE request with NOT_AUTHORIZED when `from` predates the five-year
          // edge, so an unclamped date would lose the entire window rather than
          // just its unavailable head.
          const windows: Array<[string, string]> = [];
          const clampedForward = forwardFrom < floor ? floor : forwardFrom;
          if (clampedForward <= today) windows.push([clampedForward, today]);

          const needsDeepFill =
            earliestSyncedFrom == null || earliestSyncedFrom > floor;
          if (needsDeepFill) {
            // Stop the day before the known edge so the two windows don't
            // overlap; with no known edge, take the whole plan window at once.
            const backTo =
              earliestSyncedFrom == null
                ? today
                : isoDate(addDays(new Date(earliestSyncedFrom), -1));
            if (floor <= backTo) windows.push([floor, backTo]);
          }

          if (windows.length === 0) {
            await sleep(this.bars.requestDelayMs);
            continue;
          }

          const fetched = await Promise.all(
            windows.map(([f, t]) => this.bars.fetchDailyBars(ticker, f, t)),
          );
          const result = fetched[0];
          // De-duplicate by date: the windows are disjoint by construction, but
          // a vendor that returns an inclusive edge on both would otherwise
          // write the same bar twice into one batch.
          const byDate = new Map(
            fetched.flatMap((r) => r.data).map((b) => [b.date, b]),
          );
          const bars = [...byDate.values()].sort((a, b) =>
            a.date < b.date ? -1 : 1,
          );
          if (needsDeepFill) {
            await this.meta.setEarliestSynced(JOB_NAME, ticker, floor);
          }
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
                  // Vendor-computed VWAP for the session. The MA drawer used to
                  // fabricate this row from a price multiple; it has been on
                  // every agg response all along as `vw`.
                  vwap: bar.vwap ?? null,
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
