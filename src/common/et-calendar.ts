/**
 * US Eastern calendar days. The free period (new-account intro = free trial)
 * is 7 calendar days counting the sign-up day — not 7 × 24 hours: signing up
 * on Nov 13 (any time) ends on Nov 19 at 11:59:59 PM ET (see freeWindowEnd).
 * DST-aware through the IANA zone, independent of the server's time zone.
 */
export const ET_ZONE = "America/New_York";

let fmt: Intl.DateTimeFormat | null = null;

/** Wall-clock parts in Eastern time for an instant. */
export function etParts(ms: number): {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
} {
  fmt ??= new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(
    fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    s: Number(p.second),
  };
}

/** The instant (ms) of 11:59:59 PM Eastern on the given Eastern calendar date. */
export function endOfEtDay(y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d, 23, 59, 59);
  // Eastern is UTC-4 or UTC-5: shift by the zone's offset at that moment.
  const p = etParts(guess);
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return guess + (guess - wall);
}

/** 11:59:59 PM Eastern on the calendar day `days` after `startMs`'s Eastern date. */
export function etCalendarDaysEnd(startMs: number, days: number): number {
  const p = etParts(startMs);
  const target = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return endOfEtDay(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
  );
}

/** Whole Eastern calendar days from `fromMs`'s date to `toMs`'s date. */
export function etDayDiff(toMs: number, fromMs: number): number {
  const a = etParts(toMs);
  const b = etParts(fromMs);
  return Math.round(
    (Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86_400_000,
  );
}

/**
 * End of a free period of `days` Eastern calendar days that counts the start
 * day as day 1: 11:59:59 PM ET on (start date + days − 1). Nov 13, 7 → Nov 19.
 */
export function freeWindowEnd(startMs: number, days: number): number {
  return etCalendarDaysEnd(startMs, Math.max(0, days - 1));
}

/** Calendar days left in a free period, today included (1 on the last day). */
export function freeDaysLeft(endMs: number, nowMs: number): number {
  return Math.max(0, etDayDiff(endMs, nowMs) + 1);
}
