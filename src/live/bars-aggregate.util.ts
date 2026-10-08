/**
 * Candle re-grouping for GET /live/bars?interval=… (see ondemand.service.ts).
 *
 * The bar cache stores a handful of vendor resolutions (1/5/15/30-minute and
 * daily). Every other candle size is BUILT from one of those here, so a new
 * interval costs no extra vendor call and no extra Firestore doc:
 *
 *   intraday → regular session only (09:30–16:00 ET), bucketed from the open:
 *              1H = 09:30, 10:30, … 15:30 (last bucket 30 min, as TradingView)
 *              4H = 09:30–13:30, 13:30–16:00
 *   daily    → calendar week (Mon–Fri, ET) or calendar month (ET)
 *
 * Why regular session only: vendor intraday aggregates include pre-market and
 * after-hours prints, which are thin and distort oscillators (RSI, Stoch,
 * Williams %R) read off these candles. It is also the charting-platform
 * default. And why intraday buckets are built from 30-minute bars rather than
 * the vendor's hourly ones: those start on the clock hour, so the 09:00 candle
 * would mix pre-market into the first regular hour.
 *
 * Pure functions, no I/O — everything here is unit-tested in
 * bars-aggregate.util.spec.ts.
 */

/** One OHLCV candle. Structurally identical to ondemand.service's StoredBar. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number | null;
}

/** How to turn stored bars into the requested candle size. */
export type CandleGrouping =
  /** Daily bars, returned as stored. */
  | { kind: "none" }
  /** Intraday bars: drop extended hours, merge into `minutes`-wide buckets
   *  anchored at the 09:30 ET open. `minutes` equal to the stored bar size
   *  is a pure regular-session filter. */
  | { kind: "session"; minutes: number }
  /** Daily bars merged per ET calendar week (Monday start). */
  | { kind: "week" }
  /** Daily bars merged per ET calendar month. */
  | { kind: "month" };

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Regular session, in minutes after ET midnight. */
const RTH_OPEN_MIN = 9 * 60 + 30;
const RTH_CLOSE_MIN = 16 * 60;

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
});

/**
 * ET's UTC offset in ms (−4h or −5h), memoised per UTC hour.
 *
 * Intl formatting is far too slow to call per bar (a 30-minute doc holds
 * ~5,000 bars and is re-grouped on every request). US DST transitions fall on
 * a UTC hour boundary and ET is a whole-hour offset, so one lookup per UTC hour
 * is exact. The memo is bounded: ~5 years of hours is ~44k entries.
 */
const etOffsetByHour = new Map<number, number>();
const ET_OFFSET_MEMO_MAX = 100_000;

function etOffsetMs(ms: number): number {
  const hour = Math.floor(ms / HOUR_MS);
  const hit = etOffsetByHour.get(hour);
  if (hit !== undefined) return hit;
  const at = hour * HOUR_MS;
  const p: Record<string, number> = {};
  for (const part of ET_PARTS.formatToParts(new Date(at))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const off = Date.UTC(p.year, p.month - 1, p.day, p.hour) - at;
  if (etOffsetByHour.size >= ET_OFFSET_MEMO_MAX) etOffsetByHour.clear();
  etOffsetByHour.set(hour, off);
  return off;
}

/** ET wall-clock time as a UTC-epoch number (read it with getUTC* / arithmetic). */
const etWall = (ms: number): number => ms + etOffsetMs(ms);

/** Running OHLCV accumulator for one output candle. */
interface Acc {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vwNum: number;
  vwDen: number;
}

const open = (t: number, b: Candle): Acc => {
  const acc: Acc = {
    t,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: 0,
    vwNum: 0,
    vwDen: 0,
  };
  addVolume(acc, b);
  return acc;
};

function addVolume(acc: Acc, b: Candle): void {
  acc.v += b.v;
  // VWAP of the merged candle = volume-weighted mean of the parts' VWAPs.
  // Parts without a VWAP (or volume) are left out rather than guessed.
  if (b.vw != null && b.v > 0) {
    acc.vwNum += b.vw * b.v;
    acc.vwDen += b.v;
  }
}

function merge(acc: Acc, b: Candle): void {
  if (b.h > acc.h) acc.h = b.h;
  if (b.l < acc.l) acc.l = b.l;
  acc.c = b.c;
  addVolume(acc, b);
}

const close = (acc: Acc): Candle => ({
  t: acc.t,
  o: acc.o,
  h: acc.h,
  l: acc.l,
  c: acc.c,
  v: acc.v,
  vw: acc.vwDen > 0 ? acc.vwNum / acc.vwDen : null,
});

/**
 * Merge consecutive bars sharing a bucket key. `bucket` returns null to drop a
 * bar, else its key and the timestamp the output candle should carry. Input
 * must be ascending by `t` (the cache always is); output is too.
 */
function groupBy(
  bars: readonly Candle[],
  bucket: (b: Candle) => { key: number; t: number } | null,
): Candle[] {
  const out: Candle[] = [];
  let acc: Acc | null = null;
  let accKey = NaN;
  for (const b of bars) {
    const k = bucket(b);
    if (!k) continue;
    if (acc && k.key === accKey) {
      merge(acc, b);
      continue;
    }
    if (acc) out.push(close(acc));
    acc = open(k.t, b);
    accKey = k.key;
  }
  if (acc) out.push(close(acc));
  return out;
}

/**
 * Regular-session candles of `minutes` width, anchored at the 09:30 ET open.
 * Each candle is stamped with its bucket's start time, even when the first
 * trade in it came later (an illiquid ticker's 10:30 hour may open at 10:41).
 */
export function groupSession(
  bars: readonly Candle[],
  minutes: number,
): Candle[] {
  if (!(minutes > 0))
    throw new RangeError(`bucket minutes must be > 0, got ${minutes}`);
  return groupBy(bars, (b) => {
    const wall = etWall(b.t);
    const minuteOfDay = Math.floor(
      (((wall % DAY_MS) + DAY_MS) % DAY_MS) / MIN_MS,
    );
    if (minuteOfDay < RTH_OPEN_MIN || minuteOfDay >= RTH_CLOSE_MIN) return null;
    const sinceOpen = minuteOfDay - RTH_OPEN_MIN;
    const idx = Math.floor(sinceOpen / minutes);
    const etDay = Math.floor(wall / DAY_MS);
    return {
      key: etDay * 1_000 + idx,
      t: b.t - (sinceOpen - idx * minutes) * MIN_MS,
    };
  });
}

/**
 * Weekly candles (ET calendar week, Monday start) from daily bars. Stamped with
 * the week's first session, so a week whose Monday is a holiday is dated
 * Tuesday — always a real session timestamp, never a synthetic one.
 */
export function groupWeekly(bars: readonly Candle[]): Candle[] {
  return groupBy(bars, (b) => {
    const etDay = Math.floor(etWall(b.t) / DAY_MS);
    // 1970-01-01 was a Thursday, so (etDay + 3) % 7 is 0 on Mondays.
    const monday = etDay - ((etDay + 3) % 7);
    return { key: monday, t: b.t };
  });
}

/** Monthly candles (ET calendar month) from daily bars, stamped with the month's first session. */
export function groupMonthly(bars: readonly Candle[]): Candle[] {
  return groupBy(bars, (b) => {
    const d = new Date(etWall(b.t));
    return { key: d.getUTCFullYear() * 12 + d.getUTCMonth(), t: b.t };
  });
}

/** Apply a grouping. `none` returns the input array itself (no copy). */
export function groupCandles(
  bars: readonly Candle[],
  grouping: CandleGrouping,
): readonly Candle[] {
  switch (grouping.kind) {
    case "none":
      return bars;
    case "session":
      return groupSession(bars, grouping.minutes);
    case "week":
      return groupWeekly(bars);
    case "month":
      return groupMonthly(bars);
  }
}
