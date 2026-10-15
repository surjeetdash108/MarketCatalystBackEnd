/**
 * 5-year monthly beta — the convention Yahoo, FMP and most terminals publish.
 *
 * The beta this replaces was cov/var over the last 252 DAILY returns. That is a
 * one-year, short-horizon number: daily noise dominates it, and a single year
 * in which the index was led by one sector made defensive names read negative
 * (KO −0.24, XOM −0.55 against FMP's 0.32 / 0.18). Monthly returns over five
 * years smooth the noise and match what users compare us against.
 *
 * Pure functions only: the loader (live/monthly-beta.service.ts) decides where
 * the closes come from; this file only does the arithmetic, so it is fully
 * unit-tested.
 */

/** Five years of monthly returns. */
export const BETA_MAX_RETURNS = 60;
/** Below two years the slope is too noisy to publish — shown as N/A instead. */
export const BETA_MIN_RETURNS = 24;
export const BETA_METHOD = "5y-monthly";

export interface MonthlyBeta {
  beta: number;
  /** Monthly returns actually used. */
  months: number;
  /** Share of the stock's monthly variance the market explains, 0..1. A low
   *  value means the beta is a weak description of this stock. */
  r2: number;
}

/** "2026-09-30" → "2026-09". Session dates are already New York dates. */
export function monthKey(sessionDate: string): string {
  return sessionDate.slice(0, 7);
}

/**
 * The last session of every month present in `sessionDates`, ascending, with
 * `currentMonth` dropped: its newest session is not a month-end yet, and a beta
 * built on it would move every day until the month closes.
 */
export function monthEndDates(
  sessionDates: ReadonlyArray<string>,
  currentMonth: string,
): string[] {
  const last = new Map<string, string>();
  for (const d of sessionDates) {
    const m = monthKey(d);
    if (m >= currentMonth) continue;
    const prev = last.get(m);
    if (!prev || d > prev) last.set(m, d);
  }
  return [...last.values()].sort();
}

/**
 * Drop everything up to and including the latest month-over-month move above
 * 10x or below 0.1x. Same rule, for the same reason, as the daily path's
 * trimAtStructuralBreak: a spin-off or reused ticker leaves a jump that split
 * adjustment does not remove, and the predecessor's prices are not this
 * company's history.
 */
function trimAtStructuralBreak(
  months: string[],
  closes: number[],
): { months: string[]; closes: number[] } {
  let start = 0;
  for (let i = 1; i < closes.length; i++) {
    const ratio = closes[i] / closes[i - 1];
    if (ratio > 10 || ratio < 0.1) start = i;
  }
  return { months: months.slice(start), closes: closes.slice(start) };
}

/**
 * Beta = cov(stock, market) / var(market) over aligned monthly returns.
 *
 * Both inputs map month key → month-end close. Only months present in BOTH
 * are used, and a return is taken between consecutive shared months, so a
 * month one side is missing widens both returns over the same span instead of
 * pairing mismatched periods. Returns null below BETA_MIN_RETURNS or when the
 * market did not move at all.
 */
export function computeMonthlyBeta(
  stock: ReadonlyMap<string, number>,
  market: ReadonlyMap<string, number>,
): MonthlyBeta | null {
  const valid = (v: number | undefined): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0;

  const shared = [...stock.keys()]
    .filter((m) => valid(stock.get(m)) && valid(market.get(m)))
    .sort();
  const { months } = trimAtStructuralBreak(
    shared,
    shared.map((m) => stock.get(m)),
  );

  const rs: number[] = [];
  const rm: number[] = [];
  for (let i = 1; i < months.length; i++) {
    const [prev, cur] = [months[i - 1], months[i]];
    rs.push(stock.get(cur) / stock.get(prev) - 1);
    rm.push(market.get(cur) / market.get(prev) - 1);
  }

  const n = Math.min(rs.length, BETA_MAX_RETURNS);
  if (n < BETA_MIN_RETURNS) return null;
  const a = rs.slice(-n);
  const b = rm.slice(-n);
  const meanA = a.reduce((x, y) => x + y, 0) / n;
  const meanB = b.reduce((x, y) => x + y, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - meanA) * (b[i] - meanB);
    varA += (a[i] - meanA) ** 2;
    varB += (b[i] - meanB) ** 2;
  }
  if (varB === 0) return null;
  const r2 = varA === 0 ? 0 : (cov * cov) / (varA * varB);
  return {
    beta: Math.round((cov / varB) * 1000) / 1000,
    months: n,
    r2: Math.round(r2 * 1000) / 1000,
  };
}
