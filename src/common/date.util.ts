/**
 * UTC date helpers shared by every sync job, adapter and the on-demand service.
 *
 * These were previously re-declared privately in 15+ files with identical
 * bodies. Date/window math is exactly where UTC-vs-local and inclusive-edge bugs
 * hide, and a fix applied to one private copy never propagated to the others —
 * so they live here as ONE definition.
 *
 * Everything is UTC-based on purpose: vendor calendars, SEC filing dates and
 * Firestore doc ids are all keyed on a UTC calendar day, so using the local
 * timezone would shift a day boundary for anyone running outside UTC.
 */

/** `YYYY-MM-DD` for a Date, in UTC. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` for an epoch-millis timestamp, in UTC. */
export function isoDateFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A NEW Date `n` UTC days from `d` (never mutates the input). */
export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** Absolute whole-day distance between two `YYYY-MM-DD` (or parseable) dates. */
export function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}
