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
import {
  planHistoryFloor,
  PolygonService,
  type PolygonAggBar,
} from "../vendors/polygon/polygon.service";
import { etDate } from "../common/market-calendar.util";
import { addDays, isoDate } from "../common/date.util";

const JOB_NAME = "stock-history";

/**
 * The daily increment comes from GROUPED-DAILY: one request returns every
 * symbol's bar for a session, so bringing the whole universe current costs one
 * call per missing session instead of one per ticker.
 *
 * It used to be one call per ticker in a rotating batch of 600 — sized when
 * the universe was ~586 names. activeUniverse grows with every ticker a user
 * opens; at ~1,135 names each ticker was refreshed only every other day (10-09
 * had 634 stored bars against 1,131 for 10-08), and everything derived from
 * ohlcv_bars — week5ChangePct above all — was a session staler than it looked.
 *
 * Per-ticker fetches remain only for what grouped-daily cannot do: the
 * five-year deep fill of a new ticker, and a ticker whose watermark is older
 * than the grouped window.
 */
/** Sessions grouped-daily will walk back to close a watermark gap. */
const GROUPED_LOOKBACK_SESSIONS = 10;
/**
 * Per-ticker fetches per run (deep fills, long-stale tickers), rotated with
 * the cursor. Bounded so a burst of newly-opened tickers cannot push the run
 * past the worker's 900s request timeout; the rest go next run.
 */
const PER_TICKER_CAP = 200;
/** Parallel count queries for the stranded-ticker check. */
const COUNT_CONCURRENCY = 25;

/**
 * The newest `n` weekdays strictly before `today` (ET, YYYY-MM-DD), oldest
 * first. Today is excluded: a grouped bar for a session still in progress is
 * partial and would be stored as if it were a close. Holidays are kept — they
 * come back empty from the vendor and are skipped there.
 */
export function weekdaysBefore(today: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 1; out.length < n && i <= n * 2 + 7; i++) {
    const d = isoDate(addDays(new Date(`${today}T00:00:00Z`), -i));
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out.reverse();
}

/**
 * The date windows the per-ticker path fetches for one ticker. Both END AT THE
 * LAST COMPLETED SESSION, never today.
 *
 * Two windows, because history has to grow in BOTH directions. Forward is the
 * ordinary daily increment. Backward exists because raising BACKFILL_DAYS does
 * nothing on its own: a ticker that already has a watermark only ever asks for
 * `watermark + 1 day`, so the newly available older history would never be
 * fetched and the 5Y chart would stay synthetic forever. `earliestSyncedFrom`
 * records how far back we have actually reached; when it is null the deep
 * backfill has not run for this ticker yet.
 *
 * Why not today: a run during market hours got today's still-forming bar from
 * the vendor and stored it as the session, and the watermark then moved past
 * it, so it was never fetched again. UNH's 15 Sep bar was written at 09:49 ET
 * with 110,203 shares against a real 4,393,582; 39 of the 200 movers on
 * 14 Oct carried such bars, which sank their 20-day averages and inflated RVOL
 * (UNH 3.33x for a real 1.41x), and fed the same short bars to RS, the 5-day
 * move and every indicator. The grouped path already excludes today
 * (weekdaysBefore); this is the same rule for the per-ticker path.
 */
export function perTickerWindows(opts: {
  watermark: string | null;
  earliestSyncedFrom: string | null;
  stranded: boolean;
  /** ET date (YYYY-MM-DD) of the run. */
  today: string;
  /** Oldest date the plan sells. */
  floor: string;
  /** Forward start for a never-synced ticker. */
  backfillFrom: string;
}): { windows: Array<[string, string]>; needsDeepFill: boolean } {
  const { watermark, earliestSyncedFrom, stranded, today, floor } = opts;
  const lastClosed = isoDate(addDays(new Date(`${today}T00:00:00Z`), -1));
  const forwardFrom = watermark
    ? isoDate(addDays(new Date(`${watermark}T00:00:00Z`), 1))
    : opts.backfillFrom;
  // Never ask for more history than the plan sells. Polygon rejects the
  // WHOLE request with NOT_AUTHORIZED when `from` predates the five-year
  // edge, so an unclamped date would lose the entire window rather than
  // just its unavailable head.
  const windows: Array<[string, string]> = [];
  const clampedForward = forwardFrom < floor ? floor : forwardFrom;
  if (clampedForward <= lastClosed) windows.push([clampedForward, lastClosed]);

  const needsDeepFill =
    earliestSyncedFrom == null || earliestSyncedFrom > floor || stranded;
  if (needsDeepFill) {
    // Stop the day before the known edge so the two windows don't overlap;
    // with no known edge, or a stranded ticker being refilled from scratch,
    // take the whole plan window at once.
    const backTo =
      earliestSyncedFrom == null || stranded
        ? lastClosed
        : isoDate(addDays(new Date(`${earliestSyncedFrom}T00:00:00Z`), -1));
    if (floor <= backTo) windows.push([floor, backTo]);
  }
  return { windows, needsDeepFill };
}

/**
 * Which path brings a ticker current. Grouped-daily only appends recent
 * sessions, so anything needing a deep fill, or whose gap starts before the
 * grouped window, goes per-ticker.
 */
export function routeTicker(r: {
  watermark: string | null;
  needsDeepFill: boolean;
  windowStart: string;
}): "grouped" | "per-ticker" {
  if (r.needsDeepFill || !r.watermark) return "per-ticker";
  const nextNeeded = isoDate(addDays(new Date(`${r.watermark}T00:00:00Z`), 1));
  return nextNeeded < r.windowStart ? "per-ticker" : "grouped";
}

interface SyncedRange {
  lastSyncedThrough: string | null;
  earliestSyncedFrom: string | null;
}

/** A price/volume the vendor could plausibly have meant. */
const finiteNonNegative = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * True when a daily bar is internally coherent and not from the future.
 *
 * Deliberately permissive: it rejects only what CANNOT be real, so a genuine
 * outlier (a micro-cap that really did move 900%) still stores. A zero price is
 * allowed through as non-negative but the high/low ordering check catches the
 * degenerate rows that matter.
 */
function isSaneBar(
  bar: {
    open?: unknown;
    high?: unknown;
    low?: unknown;
    close?: unknown;
    volume?: unknown;
  },
  barDate: string,
  today: string,
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(barDate)) return false;
  if (barDate > today) return false; // a session that has not happened
  const { open, high, low, close, volume } = bar;
  if (![open, high, low, close].every(finiteNonNegative)) return false;
  if (volume != null && !finiteNonNegative(volume)) return false;
  // High must bound the session; low must floor it.
  const h = high as number,
    l = low as number;
  const o = open as number,
    c = close as number;
  if (h < l) return false;
  if (o > h || c > h || o < l || c < l) return false;
  return true;
}

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
    private readonly polygon: PolygonService,
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
      // Always sync SPY: it's the benchmark the technical-indicators job needs to
      // compute beta (loadMarketCloses reads SPY from ohlcv_bars). SPY is an ETF,
      // not in the company universe, so it would otherwise never get bars and beta
      // would stay null for every ticker.
      const tickers = universe.includes("SPY")
        ? universe
        : ["SPY", ...universe];
      // ET, not UTC: between 20:00 and midnight ET the UTC date is already
      // tomorrow, which would let a not-yet-held session through.
      const today = etDate();
      const floor = planHistoryFloor();

      const ranges = await this.readRanges(tickers);
      const stranded = await this.findStranded(tickers, ranges, floor);
      const dates = weekdaysBefore(today, GROUPED_LOOKBACK_SESSIONS);

      // Detect any completed session in `dates` that is missing from ohlcv_bars
      // by checking benchmark ticker (SPY).
      const missingDates = new Set<string>();
      try {
        const spySnaps = await this.firebase.firestore.getAll(
          ...dates.map((d) =>
            this.firebase.firestore.collection("ohlcv_bars").doc(`SPY_${d}`),
          ),
        );
        dates.forEach((d, i) => {
          if (!spySnaps[i]?.exists) {
            missingDates.add(d);
          }
        });
      } catch (err) {
        this.logger.warn(
          `Failed checking missing sessions for SPY: ${(err as Error).message}`,
        );
      }

      const grouped = new Map<string, string>();
      const perTicker: string[] = [];
      for (const ticker of tickers) {
        const { lastSyncedThrough, earliestSyncedFrom } = ranges.get(ticker);
        const needsDeepFill =
          earliestSyncedFrom == null ||
          earliestSyncedFrom > floor ||
          stranded.has(ticker);
        const route = routeTicker({
          watermark: lastSyncedThrough,
          needsDeepFill,
          windowStart: dates[0],
        });
        if (route === "grouped") grouped.set(ticker, lastSyncedThrough);
        else perTicker.push(ticker);
      }

      const tickerUniverse = new Set(tickers);
      const g = await this.syncGrouped(
        grouped,
        dates,
        today,
        missingDates,
        tickerUniverse,
      );

      // Rotate the per-ticker queue with the cursor so a ticker whose fetch
      // keeps failing cannot hold the front of the queue every run.
      const cursor = await this.meta.getCursor(JOB_NAME);
      const take = Math.min(PER_TICKER_CAP, perTicker.length);
      let barsWritten = g.barsWritten;
      let rejectedBars = g.rejected;
      let tickersUpdated = g.tickersAdvanced;
      for (let i = 0; i < take; i++) {
        const ticker = perTicker[(cursor + i) % perTicker.length];
        try {
          const r = await this.syncTicker(
            ticker,
            ranges.get(ticker),
            stranded.has(ticker),
            today,
            floor,
          );
          barsWritten += r.barsWritten;
          rejectedBars += r.rejected;
          if (r.barsWritten > 0) tickersUpdated++;
        } catch (err) {
          this.logger.error(
            `Failed syncing history for ${ticker}: ${err.message}`,
          );
        }
        await sleep(this.bars.requestDelayMs);
      }
      await this.meta.setCursor(
        JOB_NAME,
        perTicker.length ? (cursor + take) % perTicker.length : 0,
      );

      if (rejectedBars > 0) {
        this.logger.warn(
          `stock-history: rejected ${rejectedBars} implausible bar(s) — see isSaneBar`,
        );
      }
      this.logger.log(
        `stock-history: ${grouped.size} via grouped-daily (${g.sessionsFetched} session(s), through ${g.coveredThrough ?? "none"}), ` +
          `${take}/${perTicker.length} per-ticker, ${barsWritten} bars written`,
      );
      await this.meta.record(JOB_NAME, { ok: true, count: barsWritten });
      return {
        barsWritten,
        tickersUpdated,
        grouped: grouped.size,
        groupedThrough: g.coveredThrough,
        perTickerDone: take,
        perTickerPending: perTicker.length - take,
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }

  /** Both watermark edges for every ticker, in batched reads. */
  private async readRanges(
    tickers: string[],
  ): Promise<Map<string, SyncedRange>> {
    const db = this.firebase.firestore;
    const out = new Map<string, SyncedRange>();
    for (let i = 0; i < tickers.length; i += 500) {
      const chunk = tickers.slice(i, i + 500);
      const snaps = await db.getAll(
        ...chunk.map((t) =>
          db.collection("sync_watermarks").doc(`${JOB_NAME}__${t}`),
        ),
      );
      snaps.forEach((snap, j) => {
        const d = snap.data() as Partial<SyncedRange> | undefined;
        out.set(chunk[j], {
          lastSyncedThrough: d?.lastSyncedThrough ?? null,
          earliestSyncedFrom: d?.earliestSyncedFrom ?? null,
        });
      });
    }
    return out;
  }

  /**
   * Self-heal tickers stranded by the old deep-fill bug. A ticker whose
   * deep window once failed was wrongly marked done (earliestSyncedFrom
   * set), so it never re-attempts the deep window and only ever accrues
   * the daily forward increment — never reaching the ≥65 bars rs-rating
   * and technical-indicators need. If it claims to be backfilled but is
   * still short, force the deep window to run again. A genuinely
   * short-history name (recent IPO) simply re-fetches its few bars each
   * run; a stranded name fills to full history once and then stops
   * qualifying (its count jumps well above the threshold).
   */
  private async findStranded(
    tickers: string[],
    ranges: Map<string, SyncedRange>,
    floor: string,
  ): Promise<Set<string>> {
    const col = this.firebase.firestore.collection("ohlcv_bars");
    const candidates = tickers.filter((t) => {
      const e = ranges.get(t)?.earliestSyncedFrom;
      return e != null && e <= floor;
    });
    const stranded = new Set<string>();
    for (let i = 0; i < candidates.length; i += COUNT_CONCURRENCY) {
      await Promise.all(
        candidates.slice(i, i + COUNT_CONCURRENCY).map(async (ticker) => {
          try {
            const cnt = await col.where("ticker", "==", ticker).count().get();
            if (cnt.data().count < MIN_HEALTHY_BARS) stranded.add(ticker);
          } catch {
            // A failed count just skips the heal for this ticker this run.
          }
        }),
      );
    }
    return stranded;
  }

  /**
   * Append the missing recent sessions for every grouped-routed ticker, one
   * grouped-daily request per session, oldest first.
   *
   * The watermark advances only to the newest session the vendor actually
   * returned bars for. An empty weekday BEFORE that is a holiday and is
   * covered by it; an empty weekday at the END may simply not be published
   * yet, so it stays open and is asked again next run rather than skipped
   * for good. A request that fails stops the walk, so a later session can
   * never move a watermark past a hole.
   *
   * Every routed ticker's watermark moves to that session, including one with
   * no bar in it (halted, no trades): grouped-daily omits exactly the
   * sessions a per-ticker request would have returned nothing for.
   */
  private async syncGrouped(
    watermarks: Map<string, string>,
    dates: string[],
    today: string,
    missingDates?: Set<string>,
    universe?: Set<string>,
  ): Promise<{
    barsWritten: number;
    rejected: number;
    tickersAdvanced: number;
    sessionsFetched: number;
    coveredThrough: string | null;
  }> {
    const empty = {
      barsWritten: 0,
      rejected: 0,
      tickersAdvanced: 0,
      sessionsFetched: 0,
      coveredThrough: null,
    };
    if (watermarks.size === 0 && (!missingDates || missingDates.size === 0)) return empty;
    const oldest = watermarks.size > 0
      ? [...watermarks.values()].reduce((a, b) => (a < b ? a : b))
      : null;
    const needed = dates.filter(
      (d) => (oldest != null && d > oldest) || (missingDates != null && missingDates.has(d)),
    );
    if (needed.length === 0) return empty;

    const db = this.firebase.firestore;
    const col = db.collection("ohlcv_bars");
    let coveredThrough: string | null = null;
    let barsWritten = 0;
    let rejected = 0;
    let sessionsFetched = 0;
    for (const date of needed) {
      let bars: PolygonAggBar[];
      try {
        bars = await this.polygon.getGroupedDaily(date);
      } catch (err) {
        this.logger.warn(
          `grouped-daily ${date} failed — stopping before it: ${(err as Error).message}`,
        );
        break;
      }
      sessionsFetched++;
      if (bars.length === 0) continue; // holiday, or not published yet

      const isBackfill = missingDates?.has(date) ?? false;
      const writes: PendingWrite[] = [];
      for (const b of bars) {
        const ticker = b.T;
        const inUniverse = universe ? universe.has(ticker) : watermarks.has(ticker);
        if (!inUniverse) continue;
        const wm = watermarks.get(ticker);
        if (!isBackfill && (wm == null || wm >= date)) continue;
        const bar = { open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v };
        // Same guard as the per-ticker path: a bar that cannot be true is
        // dropped rather than inherited by every indicator built over it.
        if (!isSaneBar(bar, date, today)) {
          rejected++;
          continue;
        }
        writes.push({
          ref: col.doc(`${ticker}_${date}`),
          data: {
            ticker,
            barDate: date,
            timespan: "day",
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            // Adjusted aggregates carry fractional share counts (BUG-011).
            volume: Math.round(b.v),
            vwap: b.vw ?? null,
            source: "polygon-grouped",
          },
          // Overwrite, never merge — same reason as the per-ticker path.
          merge: false,
        });
      }
      await batchSetWithCreatedAt(db, writes);
      barsWritten += writes.length;
      coveredThrough = date;
    }

    let tickersAdvanced = 0;
    if (coveredThrough) {
      const now = new Date().toISOString();
      const marks: PendingWrite[] = [];
      for (const [ticker, wm] of watermarks) {
        if (wm >= coveredThrough) continue;
        marks.push({
          ref: db.collection("sync_watermarks").doc(`${JOB_NAME}__${ticker}`),
          data: {
            jobName: JOB_NAME,
            entityKey: ticker,
            lastSyncedThrough: coveredThrough,
            updatedAt: now,
          },
        });
      }
      await batchSetWithCreatedAt(db, marks);
      tickersAdvanced = marks.length;
    }
    return {
      barsWritten,
      rejected,
      tickersAdvanced,
      sessionsFetched,
      coveredThrough,
    };
  }

  /** The per-ticker path: deep fill and/or a forward window for one ticker. */
  private async syncTicker(
    ticker: string,
    range: SyncedRange,
    stranded: boolean,
    today: string,
    floor: string,
  ): Promise<{ barsWritten: number; rejected: number }> {
    const { lastSyncedThrough: watermark, earliestSyncedFrom } = range;
    let rejected = 0;

    const { windows, needsDeepFill } = perTickerWindows({
      watermark,
      earliestSyncedFrom,
      stranded,
      today,
      floor,
      backfillFrom: isoDate(addDays(new Date(), -BACKFILL_DAYS)),
    });

    if (windows.length === 0) return { barsWritten: 0, rejected };

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
    if (bars.length === 0) return { barsWritten: 0, rejected };

    const writes: PendingWrite[] = [];
    const col = this.firebase.firestore.collection("ohlcv_bars");
    let lastDate = watermark;
    for (const bar of bars) {
      const barDate = bar.date;
      // Reject a bar that cannot be true before it is stored.
      //
      // Nothing validated vendor numbers on the way in, so a NaN, an
      // Infinity, a negative price or a future-dated session would be
      // written verbatim and then silently poison every window
      // indicator built on it — 52-week range, SMA/EMA, MACD, beta,
      // pivots — for as long as it stayed inside the window. Dropping
      // the bar costs one session; storing it corrupts a year of
      // derived values.
      if (!isSaneBar(bar, barDate, today)) {
        rejected++;
        continue;
      }
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
    if (lastDate) await this.meta.setWatermark(JOB_NAME, ticker, lastDate);
    return { barsWritten: bars.length, rejected };
  }
}
