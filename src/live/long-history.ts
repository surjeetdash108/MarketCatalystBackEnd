/**
 * A stock's full daily price history — from its listing date — for the chart's
 * daily / weekly / monthly candles. The stored stock_bars docs come from
 * Polygon, whose plan holds 5 years; FMP's split-adjusted EOD history reaches
 * back to the listing (AAPL from 1980-12-12), so the days before the first
 * stored bar are fetched from FMP and put in front.
 *
 * FMP answers at most LONG_HISTORY_PAGE rows per call (newest first), so the
 * fetch pages backwards — `to` = the day before the oldest row so far — until
 * a short page says the listing date is reached. Any failure returns what was
 * gathered (usually nothing): the 5-year window still serves.
 */
import { toFmpSymbol } from "../vendors/market-data/fmp-mapping.util";

export const LONG_HISTORY_PAGE = 5000;
/** Enough pages for ~100 years of sessions; a guard, never reached in practice. */
const MAX_PAGES = 6;
const EARLIEST = "1900-01-01";

export interface DailyBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number | null;
}

type FmpRequest = (path: string) => Promise<unknown[]>;

/** Midnight America/New_York of a YYYY-MM-DD day, in ms — how Polygon stamps daily aggregates. */
export function etMidnightMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const noonUtc = Date.UTC(y, m - 1, d, 12);
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(noonUtc),
  );
  // 12:00 UTC is 08:00 EDT or 07:00 EST: the offset is 4 or 5 hours.
  return Date.UTC(y, m - 1, d, 12 - etHour);
}

const prevDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

/** Every daily bar strictly before `beforeDay` (YYYY-MM-DD), oldest first. */
export async function fetchOlderDaily(request: FmpRequest, ticker: string, beforeDay: string): Promise<DailyBar[]> {
  const out: DailyBar[] = [];
  let to = prevDay(beforeDay);
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = (await request(
        `historical-price-eod/full?symbol=${encodeURIComponent(toFmpSymbol(ticker))}&from=${EARLIEST}&to=${to}`,
      )) as Array<Record<string, unknown>>;
      const bars = rows
        .map((r) => ({ day: String(r.date ?? ""), o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close), v: num(r.volume) }))
        .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day) && r.day < beforeDay && [r.o, r.h, r.l, r.c].every((x) => x > 0));
      if (!bars.length) break;
      for (const r of bars) out.push({ t: etMidnightMs(r.day), o: r.o, h: r.h, l: r.l, c: r.c, v: Number.isFinite(r.v) ? r.v : 0, vw: null });
      const oldest = bars.reduce((a, r) => (r.day < a ? r.day : a), bars[0].day);
      if (rows.length < LONG_HISTORY_PAGE) break;
      to = prevDay(oldest);
    }
  } catch {
    /* vendor error: keep what was gathered — the stored window still serves */
  }
  const seen = new Set<number>();
  return out.filter((b) => (seen.has(b.t) ? false : (seen.add(b.t), true))).sort((a, b) => a.t - b.t);
}

/** `older` bars before the first `recent` bar, then `recent` (the stored bar wins on overlap). */
export function prependOlder<T extends { t: number }>(older: readonly T[], recent: T[]): T[] {
  if (!older.length || !recent.length) return recent;
  const first = recent[0].t;
  const head = older.filter((b) => b.t < first);
  return head.length ? [...head, ...recent] : recent;
}
