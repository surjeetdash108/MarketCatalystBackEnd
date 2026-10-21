/**
 * Compact bar storage for Strategy Lab's universe backtests.
 *
 * One Firestore document per stock (per candle size) holds its whole history
 * as raw little-endian Float64 columns in Bytes fields — ~44 bytes a bar, so
 * 11 years of daily bars (~2,770) is ~120 KB, well under the 1 MiB doc limit,
 * and decoding is a copy into typed arrays rather than parsing 2,770 objects.
 *
 * Timestamps: the bar's own date string (daily "YYYY-MM-DD", intraday
 * "YYYY-MM-DD HH:MM:SS" US/Eastern wall time, as FMP serves it) encoded as if
 * it were UTC. That round-trips the exact string without any timezone math.
 */

/** [date, open, high, low, close, volume] — same tuple the bars endpoint serves. */
export type LabBar = [string, number, number, number, number, number];

export interface BarPack {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  /** True for intraday packs (timestamps carry a time of day). */
  intraday: boolean;
}

/** The engine's bar shape (app/iq/sl/engine.js normalizeFmp output). */
export interface EngineBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const COLS = ["t", "o", "h", "l", "c", "v"] as const;

export const encodeTime = (s: string): number =>
  Date.parse(
    s.length > 10 ? `${s.slice(0, 10)}T${s.slice(11, 19)}Z` : `${s}T00:00:00Z`,
  );

export function decodeTime(ms: number, intraday: boolean): string {
  const iso = new Date(ms).toISOString();
  return intraday
    ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
    : iso.slice(0, 10);
}

/** Rows (ascending, de-duplicated by timestamp) → pack. */
export function packFromRows(rows: LabBar[], intraday: boolean): BarPack {
  const n = rows.length;
  const p: BarPack = {
    t: new Float64Array(n),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    v: new Float64Array(n),
    intraday,
  };
  rows.forEach((r, i) => {
    p.t[i] = encodeTime(r[0]);
    p.o[i] = r[1];
    p.h[i] = r[2];
    p.l[i] = r[3];
    p.c[i] = r[4];
    p.v[i] = r[5];
  });
  return p;
}

export function packToRows(p: BarPack, from = 0): LabBar[] {
  const out: LabBar[] = [];
  for (let i = from; i < p.t.length; i++)
    out.push([
      decodeTime(p.t[i], p.intraday),
      p.o[i],
      p.h[i],
      p.l[i],
      p.c[i],
      p.v[i],
    ]);
  return out;
}

/** Bars from index `from` in the engine's object shape. */
export function packToEngineBars(p: BarPack, from = 0): EngineBar[] {
  const out: EngineBar[] = new Array(Math.max(0, p.t.length - from));
  for (let i = from; i < p.t.length; i++)
    out[i - from] = {
      date: decodeTime(p.t[i], p.intraday),
      open: p.o[i],
      high: p.h[i],
      low: p.l[i],
      close: p.c[i],
      volume: p.v[i],
    };
  return out;
}

/** First index whose timestamp is ≥ `ms` (binary search; t is ascending). */
export function indexAtOrAfter(p: BarPack, ms: number): number {
  let lo = 0,
    hi = p.t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.t[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function lastDate(p: BarPack): string | null {
  return p.t.length ? decodeTime(p.t[p.t.length - 1], p.intraday) : null;
}

/** Pack → Firestore fields (Bytes columns + small metadata). */
export function encodePack(p: BarPack): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    n: p.t.length,
    intraday: p.intraday,
    first: p.t.length ? decodeTime(p.t[0], p.intraday) : null,
    last: lastDate(p),
  };
  for (const k of COLS)
    doc[k] = Buffer.from(p[k].buffer, p[k].byteOffset, p[k].byteLength);
  return doc;
}

/** Firestore doc → pack. Copies each column into an aligned Float64Array. */
export function decodePack(doc: Record<string, unknown>): BarPack {
  const col = (k: string): Float64Array => {
    const raw = doc[k] as Uint8Array | undefined;
    if (!raw || !raw.byteLength) return new Float64Array(0);
    const ab = new ArrayBuffer(raw.byteLength);
    new Uint8Array(ab).set(raw);
    return new Float64Array(ab);
  };
  return {
    t: col("t"),
    o: col("o"),
    h: col("h"),
    l: col("l"),
    c: col("c"),
    v: col("v"),
    intraday: doc.intraday === true,
  };
}

/**
 * Merge new rows into existing ones (new wins on the same timestamp), keep
 * ascending order, and drop rows older than `keepFromMs` when given.
 */
export function mergeRows(
  existing: LabBar[],
  incoming: LabBar[],
  keepFromMs?: number,
): LabBar[] {
  const byTime = new Map<number, LabBar>();
  for (const r of existing) byTime.set(encodeTime(r[0]), r);
  for (const r of incoming) byTime.set(encodeTime(r[0]), r);
  return [...byTime.entries()]
    .filter(([t]) => keepFromMs == null || t >= keepFromMs)
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => r);
}

/**
 * Aggregate intraday bars into larger candles within each session, aligned
 * to the 09:30 open (FMP's own 30-min / 1-hour / 4-hour bars start there too:
 * a 4-hour session splits 09:30–13:30 and 13:30–16:00).
 */
export function aggregateIntraday(
  bars: EngineBar[],
  minutes: number,
): EngineBar[] {
  const out: EngineBar[] = [];
  let cur: EngineBar | null = null;
  let key = "";
  for (const b of bars) {
    const day = b.date.slice(0, 10);
    const [hh, mm] = b.date.slice(11, 16).split(":").map(Number);
    const bucket = Math.floor((hh * 60 + mm - 570) / minutes);
    const k = `${day}|${bucket}`;
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      const start = 570 + bucket * minutes;
      const label = `${day} ${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}:00`;
      cur = {
        date: label,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      };
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}
