import { etDate } from "../common/market-calendar.util";
import type { PolygonAggBar } from "../vendors/polygon/polygon.service";

/**
 * The last COMPLETED sessions for a ticker, and the check that says when a
 * snapshot figure has to be rebuilt from them.
 *
 * WHY
 * Outside the regular session Polygon's snapshot rolls over before the next
 * open: `close` and `previous_close` both become the last close, so every move
 * reads a flat +0.00% and the tile shows "yesterday's close, unchanged" from the
 * rollover until the open (T175). The fix is to show the last session's real
 * close and move, rebuilt from the last two completed daily bars.
 *
 * Shared by the app tape (TapeService) and the landing tape
 * (LandingTapeService), which had its own private copy of this logic.
 */

export type MarketPhase = "open" | "pre" | "after" | "closed" | "unknown";

/** One completed daily session. `date` is the ET session date (YYYY-MM-DD). */
export interface DailyClose {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface ClosePair {
  last: DailyClose;
  prev: DailyClose;
}

/** How far back to look for two completed sessions (covers long holiday weekends). */
const LOOKBACK_DAYS = 14;

/**
 * Minutes after midnight ET from which TODAY's daily bar counts as a completed
 * session: the 16:00 close plus the ~15-minute vendor delay plus a margin. Before
 * that, today's bar is either pre-market prints or a session still filling in.
 */
const SESSION_FINAL_MIN = 16 * 60 + 30;

/** Minutes since midnight ET. */
export function etMinutes(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/**
 * True when a snapshot figure no longer describes a session: outside regular
 * hours with the price sitting exactly on the previous close (or a figure is
 * missing). During the regular session (or an unknown one) nothing is "rolled".
 */
export function isRolled(
  it: {
    value: number | null;
    prevClose: number | null;
    pctChange: number | null;
  },
  phase: MarketPhase,
): boolean {
  // An unknown phase may well be the regular session: never rebuild then, so a
  // genuinely flat stock during market hours is not replaced by yesterday.
  if (phase === "open" || phase === "unknown") return false;
  if (it.value == null || it.pctChange == null || it.prevClose == null)
    return true;
  return Math.abs(it.value - it.prevClose) < 1e-9 || it.pctChange === 0;
}

/**
 * Daily bars reduced to completed sessions, oldest first. Today's bar is kept
 * only once the session is final (see SESSION_FINAL_MIN); before that it is the
 * half-formed session this fallback exists to avoid.
 */
export function completedSessionBars(
  bars: Pick<PolygonAggBar, "t" | "o" | "h" | "l" | "c">[],
  now: Date = new Date(),
): DailyClose[] {
  const today = etDate(now);
  const todayFinal = etMinutes(now) >= SESSION_FINAL_MIN;
  return bars
    .map((b) => ({
      date: etDate(new Date(b.t)),
      o: b.o,
      h: b.h,
      l: b.l,
      c: b.c,
    }))
    .filter((b) => Number.isFinite(b.c))
    .filter((b) => b.date < today || (b.date === today && todayFinal));
}

/** The last two completed sessions, or null when there are fewer than two. */
export function lastTwoCloses(bars: DailyClose[]): ClosePair | null {
  if (bars.length < 2) return null;
  return { last: bars[bars.length - 1], prev: bars[bars.length - 2] };
}

/** Percent move, rounded to 2 dp like every other tile. */
export function pctMove(now: number, prev: number): number {
  return Math.round(((now - prev) / prev) * 10000) / 100;
}

/**
 * Last two completed sessions per ticker, cached per "window": the ET date plus
 * whether today's session is final yet. So a ticker costs at most two daily-bar
 * calls a day (one before the close, one after), however often it is asked for.
 * Keeps the last good pair when the vendor fails.
 */
export class DailyClosesCache {
  private readonly pairs = new Map<
    string,
    { window: string; pair: ClosePair | null }
  >();

  constructor(
    private readonly polygon: {
      getAggsRange(
        ticker: string,
        from: string,
        to: string,
      ): Promise<PolygonAggBar[]>;
    },
    private readonly logger: { warn(message: string): void },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async get(ticker: string): Promise<ClosePair | null> {
    const now = this.clock();
    const window = `${etDate(now)}|${etMinutes(now) >= SESSION_FINAL_MIN ? "final" : "open"}`;
    const hit = this.pairs.get(ticker);
    if (hit && hit.window === window) return hit.pair;

    try {
      const from = etDate(new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000));
      const bars = await this.polygon.getAggsRange(ticker, from, etDate(now));
      const pair =
        lastTwoCloses(completedSessionBars(bars, now)) ?? hit?.pair ?? null;
      this.pairs.set(ticker, { window, pair });
      return pair;
    } catch (err) {
      this.logger.warn(
        `daily closes for ${ticker} failed: ${(err as Error)?.message ?? err}`,
      );
      return hit?.pair ?? null;
    }
  }
}
