/**
 * Corporate-actions derivations — pure functions shared by the on-demand
 * dividend-history endpoint (src/live/ondemand.service.ts).
 *
 * The former CorporateActionsJob cron class (which swept the universe writing
 * `dividend_history` / `splits` docs) was retired along with the rest of the
 * sync machinery; only these vendor-agnostic derivations remain.
 */

interface AnnualTotal {
  year: number;
  total: number;
  payments: number;
}

/**
 * Calendar-year totals by ex-date, newest first. Calendar rather than fiscal
 * because the chart's x-axis is years and the vendor supplies no fiscal mapping
 * for distributions.
 */
export function annualTotals(
  history: Array<{ exDividendDate: string | null; cashAmount: number }>,
): AnnualTotal[] {
  const byYear = new Map<number, { total: number; payments: number }>();
  for (const d of history) {
    if (!d.exDividendDate) continue;
    const year = Number(d.exDividendDate.slice(0, 4));
    if (!Number.isFinite(year)) continue;
    const cur = byYear.get(year) ?? { total: 0, payments: 0 };
    cur.total += d.cashAmount ?? 0;
    cur.payments += 1;
    byYear.set(year, cur);
  }
  return [...byYear.entries()]
    .map(([year, v]) => ({
      year,
      total: Math.round(v.total * 10000) / 10000,
      payments: v.payments,
    }))
    .sort((a, b) => b.year - a.year);
}

/**
 * Compound annual growth over `years` COMPLETE calendar years. The current year
 * is excluded — it is partial by definition, and including it reads as a ~75%
 * dividend cut every January.
 */
export function dividendCagr(
  totals: AnnualTotal[],
  years: number,
): number | null {
  const thisYear = new Date().getUTCFullYear();
  const complete = totals.filter((t) => t.year < thisYear);
  if (complete.length < years + 1) return null;
  const latest = complete[0];
  const base = complete[years];
  if (!base || base.total <= 0 || latest.total <= 0) return null;
  const cagr = (latest.total / base.total) ** (1 / years) - 1;
  return Number.isFinite(cagr) ? Math.round(cagr * 10000) / 100 : null;
}

/** Consecutive complete years, most recent first, whose total exceeded the prior year's. */
export function increaseStreak(totals: AnnualTotal[]): number {
  const thisYear = new Date().getUTCFullYear();
  const complete = totals.filter((t) => t.year < thisYear);
  let streak = 0;
  for (let i = 0; i < complete.length - 1; i++) {
    // Only count strictly consecutive years — a gap means the streak is broken,
    // not that the years either side should be compared to each other.
    if (complete[i].year !== complete[i + 1].year + 1) break;
    if (complete[i].total > complete[i + 1].total) streak++;
    else break;
  }
  return streak;
}
