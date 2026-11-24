import { etParts } from "../common/et-calendar";

/**
 * When a stored chart-bar doc (`stock_bars/{TICKER}_{resolution}`) may still be
 * served instead of re-fetched.
 *
 * It used to be age alone: daily docs for 20 h, intraday docs for 15 min during
 * 04:00-20:00 ET and 12 h outside it. Age says nothing about WHICH session the
 * doc caught, so a doc saved at 09:20 ET (before the open) had no candle for the
 * day and a doc saved at 11:35 ET held a half-finished one, and both were served
 * as "fresh" through the close and into the next morning (24 Nov 2026: NVDA's
 * chart ended on Friday's $125.53 while the quote said $165.05 after a +31% day;
 * AAPL's Monday candle closed at 348.37 against the official 349.08).
 *
 * So a doc must ALSO have been saved after the most recent session boundary that
 * has passed:
 *  - daily bars: the regular open (so today's candle exists) and the settle point
 *    after the close (so it is final, not a mid-session snapshot);
 *  - intraday bars (which include pre- and after-hours): the settle point after
 *    the extended session ends.
 * The settle points sit 30 minutes after 16:00 / 20:00 because the bar feed is
 * ~15 minutes delayed. A viewed ticker costs at most two daily-doc refreshes a day
 * (the first view after 09:30 and after 16:30); each is the usual incremental fetch.
 *
 * Weekdays only. A market holiday looks like a normal day, which costs one
 * harmless extra refresh, so no holiday table is needed.
 */

const DAILY_TTL_MS = 20 * 3600_000;
/** Intraday docs while extended trading (04:00-20:00 ET) can still move them. */
const INTRADAY_SESSION_TTL_MS = 15 * 60_000;
const INTRADAY_IDLE_TTL_MS = 12 * 3600_000;

const OPEN_MIN = 9 * 60 + 30;
/** 16:00 close + 30 min: the delayed feed has the final daily candle. */
const DAILY_SETTLED_MIN = 16 * 60 + 30;
/** 20:00 end of after-hours + 30 min: the delayed feed has the last intraday bar. */
const INTRADAY_SETTLED_MIN = 20 * 60 + 30;

/** The instant of a US Eastern wall-clock time (DST-aware; not for the 2 a.m. transition). */
function etWallMs(y: number, m: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = etParts(guess);
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return guess + (guess - wall);
}

/**
 * The latest weekday boundary at or before `nowMs`, from the given minutes of the
 * Eastern day. 0 if none is found within the last week.
 */
export function lastBoundary(nowMs: number, minutesOfDay: number[]): number {
  const today = etParts(nowMs);
  const latestFirst = [...minutesOfDay].sort((a, b) => b - a);
  for (let back = 0; back <= 6; back++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d - back));
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (const min of latestFirst) {
      const at = etWallMs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(min / 60), min % 60);
      if (at <= nowMs) return at;
    }
  }
  return 0;
}

/** True while US extended trading (04:00-20:00 ET weekdays) can still move intraday bars. */
function inExtendedSession(nowMs: number): boolean {
  const p = etParts(nowMs);
  const weekday = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return weekday >= 1 && weekday <= 5 && p.h >= 4 && p.h < 20;
}

/** Whether a stored bars doc saved at `createdAtIso` can be served at `nowMs`. */
export function isBarsDocFresh(createdAtIso: string | undefined, daily: boolean, nowMs: number = Date.now()): boolean {
  if (!createdAtIso) return false;
  const created = Date.parse(createdAtIso);
  const age = nowMs - created;
  if (!Number.isFinite(age) || age < 0) return false;

  if (daily) {
    return age < DAILY_TTL_MS && created >= lastBoundary(nowMs, [OPEN_MIN, DAILY_SETTLED_MIN]);
  }
  // Intraday: refetch every 15 min while a session is running; outside it, a doc
  // is good only if it was saved after the session ended.
  if (inExtendedSession(nowMs)) return age < INTRADAY_SESSION_TTL_MS;
  return age < INTRADAY_IDLE_TTL_MS && created >= lastBoundary(nowMs, [INTRADAY_SETTLED_MIN]);
}
