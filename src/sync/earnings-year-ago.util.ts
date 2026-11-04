import { addDays, isoDate } from "../common/date.util";

/** Slice of a `financials/{ticker}.quarters[]` entry this lookup reads. */
export interface YearAgoQuarter {
  endDate?: string | null;
  epsActualReported?: number | null;
  revenue?: number | null;
}

/** Slice of an `earnings_events` row `needsYearAgo` reads. */
export interface YearAgoRow {
  epsActual?: number | null;
  revenueActual?: number | null;
  epsActualYearAgo?: number | null;
  revenueYearAgo?: number | null;
}

/**
 * True when a row has reported but still carries no year-ago comparable. An
 * upcoming row has nothing to compare yet, and a row that already has either
 * year-ago value is left alone.
 */
export function needsYearAgo(row: YearAgoRow): boolean {
  return (
    row.epsActualYearAgo == null &&
    row.revenueYearAgo == null &&
    (row.epsActual != null || row.revenueActual != null)
  );
}

// The quarter we want ended before last year's report did. Reports land ~10-90
// days after quarter-end, so the latest quarter-end on or before (reportDate −
// 1y) is last year's comparable. A match further back than this is a gap in the
// history (a missing quarter), not the right quarter — better blank than wrong.
const MAX_GAP_DAYS = 110;

/**
 * Same quarter, previous year, for an earnings row that carries NO fiscal
 * period/year — i.e. every row from the FMP calendar, which has only a report
 * date. Matches on dates instead: the latest stored quarter-end on or before
 * `reportDate − 1 year`.
 *
 * Returns null when there is no quarter close enough, so the UI shows "—"
 * rather than a number from the wrong period.
 */
export function pickYearAgoByReportDate(
  quarters: YearAgoQuarter[],
  reportDate: string,
): { eps: number | null; rev: number | null } | null {
  const base = new Date(`${reportDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  const cutoff = isoDate(addDays(base, -365));
  const floor = isoDate(addDays(base, -365 - MAX_GAP_DAYS));

  let best: YearAgoQuarter | null = null;
  for (const q of quarters) {
    const end = q.endDate?.slice(0, 10);
    if (!end || end > cutoff || end < floor) continue;
    if (!best || end > (best.endDate as string).slice(0, 10)) best = q;
  }
  if (!best) return null;
  const eps = best.epsActualReported ?? null;
  const rev = best.revenue ?? null;
  return eps == null && rev == null ? null : { eps, rev };
}
