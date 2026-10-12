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

/**
 * Converts a US Eastern Time (`America/New_York`) date/time string (e.g. from FMP
 * like "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DD") to an authoritative UTC ISO string.
 *
 * FMP sends news and bar timestamps formatted in US Eastern Time without a timezone
 * offset. Naively appending "Z" mistakenly treats New York time as UTC, causing
 * a 4-hour (EDT) or 5-hour (EST) lag in live feeds. This function accurately resolves
 * the Daylight Saving Time offset for the specific date.
 */
export function fmpEasternToUtcIso(dateStr: string | null | undefined): string {
  if (!dateStr) return new Date().toISOString();
  const trimmed = String(dateStr).trim();
  if (!trimmed) return new Date().toISOString();

  // If the string already has a UTC indicator ('Z') or offset (+/-HH:MM), parse directly.
  if (trimmed.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  // Parse YYYY-MM-DD HH:mm:ss or YYYY-MM-DD
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) {
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  const [, y, mo, d, h = "00", min = "00", s = "00"] = m;
  const utcGuess = new Date(Date.UTC(+y, +mo - 1, +d, +h, +min, +s));

  // Determine exact America/New_York offset for this date
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(utcGuess);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const nyHour = parseInt(getPart("hour"), 10) % 24;
  const nyAsUtc = Date.UTC(
    parseInt(getPart("year"), 10),
    parseInt(getPart("month"), 10) - 1,
    parseInt(getPart("day"), 10),
    nyHour,
    parseInt(getPart("minute"), 10),
    parseInt(getPart("second"), 10),
  );

  const offsetMs = utcGuess.getTime() - nyAsUtc;
  const trueUtc = new Date(utcGuess.getTime() + offsetMs);
  return trueUtc.toISOString();
}

