import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  type PendingWrite,
} from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { activeUniverse } from "../common/ticker-universe";
import { MARKET_BARS_ADAPTER, type MarketBarsAdapter } from "../adapters/types";
import { SyncRegistry } from "../common/sync-registry.service";
import { planHistoryFloor } from "../vendors/polygon/polygon.service";
import { addDays, isoDate } from "../common/date.util";

const JOB_NAME = "stock-history";
// Whole universe per run. At 60/day against ~586 names `ohlcv_bars` took ~10
// DAYS to cycle, so most tickers' bars were days stale — and everything derived
// from them was wrong, not just old: technical-indicators computes
// week5ChangePct off this collection, and a sample showed 59% of values
// disagreeing with the real bars including outright SIGN FLIPS (BOXL stored
// +117.9% vs a real -18.6%, ACH -66.0% vs +26.2%, and blue chips like NIO/D/ACM
// inverted too).
//
// Cheap because writes are INCREMENTAL from a per-ticker watermark: a daily run
// appends ~1 bar per ticker (~586 writes/day ≈ $0.03/mo), not a full re-fetch.
// Only a brand-new ticker pays the ~252-doc deep fill, once.
const BATCH_SIZE = 600;

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

/**
 * Below this many stored bars a ticker cannot be scored by rs-rating (which
 * needs ≥65) or the technical-indicators job. Used to detect tickers stranded
 * by the old deep-fill bug — see the self-heal guard in run().
 */
const MIN_HEALTHY_BARS = 65;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));



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
      collections: ["ohlcv_bars"],
      cronExpression: "0 3 * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const universe = await activeUniverse(this.firebase.firestore);
      if (universe.length === 0) {
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { count: 0, note: "no active tickers yet" };
      }
      // Batch never larger than the active universe, so a small
      // universe is fully covered in one premarket run.
      const cursor = await this.meta.getCursor(JOB_NAME);
      const rotating = Array.from(
        { length: Math.min(BATCH_SIZE, universe.length) },
        (_, i) => universe[(cursor + i) % universe.length],
      );
      // Always sync SPY: it's the benchmark the technical-indicators job needs to
      // compute beta (loadMarketCloses reads SPY from ohlcv_bars). SPY is an ETF,
      // not in the company universe, so it would otherwise never get bars and beta
      // would stay null for every ticker.
      const batch = rotating.includes("SPY") ? rotating : ["SPY", ...rotating];
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

          // Self-heal tickers stranded by the old deep-fill bug. A ticker whose
          // deep window once failed was wrongly marked done (earliestSyncedFrom
          // set), so it never re-attempts the deep window and only ever accrues
          // the daily forward increment — never reaching the ≥65 bars rs-rating
          // and technical-indicators need. If it claims to be backfilled but is
          // still short, force the deep window to run again. A genuinely
          // short-history name (recent IPO) simply re-fetches its few bars each
          // run; a stranded name fills to full history once and then stops
          // qualifying (its count jumps well above the threshold).
          let stranded = false;
          if (earliestSyncedFrom != null && earliestSyncedFrom <= floor) {
            const cnt = await this.firebase.firestore
              .collection("ohlcv_bars")
              .where("ticker", "==", ticker)
              .count()
              .get();
            if (cnt.data().count < MIN_HEALTHY_BARS) stranded = true;
          }

          const needsDeepFill =
            earliestSyncedFrom == null || earliestSyncedFrom > floor || stranded;
          if (needsDeepFill) {
            // Stop the day before the known edge so the two windows don't
            // overlap; with no known edge — or a stranded ticker being refilled
            // from scratch — take the whole plan window at once.
            const backTo =
              earliestSyncedFrom == null || stranded
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
          // Only record the deep-fill as done when it actually returned bars.
          // Marking it on an empty/failed fetch (the previous behaviour) stranded
          // the ticker forever: it would never re-attempt the deep window and
          // would only ever accrue the ~daily forward increment, so it never
          // reached the ≥65 bars rs-rating needs — leaving most companies
          // unranked. On an empty fetch we leave it un-marked so a later run
          // retries the deep window.
          if (needsDeepFill && bars.length > 0) {
            await this.meta.setEarliestSynced(JOB_NAME, ticker, floor);
          }
          if (bars.length > 0) {
            const writes: PendingWrite[] = [];
            const col = this.firebase.firestore.collection("ohlcv_bars");
            let lastDate = watermark;
            for (const bar of bars) {
              const barDate = bar.date;
              writes.push({
                ref: col.doc(`${ticker}_${barDate}`),
                data: {
                  ticker,
                  barDate,
                  timespan: "day",
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
              if (!lastDate || barDate > lastDate) lastDate = barDate;
            }
            await batchSetWithCreatedAt(this.firebase.firestore, writes);
            if (lastDate)
              await this.meta.setWatermark(JOB_NAME, ticker, lastDate);
            barsWritten += bars.length;
            tickersUpdated++;
          }
        } catch (err) {
          this.logger.error(
            `Failed syncing history for ${ticker}: ${err.message}`,
          );
        }
        await sleep(this.bars.requestDelayMs);
      }
      await this.meta.setCursor(
        JOB_NAME,
        (cursor + BATCH_SIZE) % universe.length,
      );
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
