/**
 * Calendar helpers for the weekly and monthly analysis jobs (spec §8, §9).
 *
 * §9 is explicit: "Do not run the monthly job simply because it is Friday."
 * The monthly job fires only when today's Friday is the LAST Friday of the
 * month, which is not the same as "the Friday in the last 7 days of the
 * month" in every month, and is not the same as the 4th Friday either — a
 * month can have five. So it is computed, not approximated, and tested.
 *
 * All reasoning is in America/New_York, since "after the market has closed"
 * is a US-market statement. Dates are handled as YYYY-MM-DD strings in ET to
 * avoid a UTC instant silently landing on the previous or next day.
 */

const ET = "America/New_York";

/** YYYY-MM-DD for an instant, as seen in New York. */
export function etDate(d: Date = new Date()): string {
  // en-CA renders ISO-style YYYY-MM-DD, which sorts and slices predictably.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/** 0=Sun … 5=Fri … 6=Sat, as seen in New York. */
export function etWeekday(d: Date = new Date()): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, weekday: "short",
  }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

export function isFriday(d: Date = new Date()): boolean {
  return etWeekday(d) === 5;
}

/** Days in a month, from a YYYY-MM-DD string. */
function daysInMonth(iso: string): number {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The LAST Friday of the month containing `iso` (YYYY-MM-DD), as YYYY-MM-DD.
 *
 * Walks back from the final day of the month until it hits a Friday — correct
 * for months with four Fridays and months with five, and for months ending on
 * any weekday.
 */
export function lastFridayOf(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const last = daysInMonth(iso);
  for (let day = last; day > last - 7; day--) {
    // UTC is safe here: this is pure calendar arithmetic on a date with no
    // time component, not a conversion of an instant.
    const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    if (dow === 5) {
      return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  /* istanbul ignore next — every 28+ day month contains a Friday. */
  throw new Error(`no Friday found in ${iso}`);
}

/** §9's gate: today is a Friday AND it is this month's last Friday. */
export function isLastFridayOfMonth(d: Date = new Date()): boolean {
  const today = etDate(d);
  return isFriday(d) && lastFridayOf(today) === today;
}

/** Monday…Sunday bounds of the week containing `iso`, for weekly records. */
export function weekBounds(iso: string): { start: string; end: string } {
  const [y, m, day] = iso.split("-").map(Number);
  const base = Date.UTC(y, m - 1, day);
  const dow = new Date(base).getUTCDay();       // 0=Sun
  const backToMonday = dow === 0 ? 6 : dow - 1; // Sunday belongs to the week before
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    start: fmt(base - backToMonday * 86_400_000),
    end: fmt(base + (6 - backToMonday) * 86_400_000),
  };
}

/** First/last day of the month containing `iso`. */
export function monthBounds(iso: string): { start: string; end: string } {
  const [y, m] = iso.split("-").map(Number);
  const mm = String(m).padStart(2, "0");
  return {
    start: `${y}-${mm}-01`,
    end: `${y}-${mm}-${String(daysInMonth(iso)).padStart(2, "0")}`,
  };
}

/** "2026-08" key used to tie a monthly analysis to its cleanup. */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}
