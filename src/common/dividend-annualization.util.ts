/**
 * Forward-annualized dividend from a ticker's Polygon dividend history — the
 * single source of truth shared by the company-profile adapter (nightly sweep)
 * and live/ondemand.service (on-view), so the derived yield can never diverge
 * between the two write paths. `sync/dividends.job` uses a DIFFERENT basis (an
 * FMP-calendar per-event run-rate) and deliberately does not use these helpers.
 */

/**
 * Distribution-type codes Polygon uses for NON-regular payments (special cash,
 * long-term / short-term capital-gains). Excluded from the forward run-rate so a
 * one-off does not masquerade as the recurring dividend.
 */
export const SPECIAL_DIVIDEND_TYPES = new Set(["SC", "LT", "ST"]);

/** Subset of a Polygon getDividendHistory() row the forward yield needs. */
export interface DivHistItem {
  exDividendDate: string | null;
  cashAmount: number | null;
  dividendType: string | null;
  frequency: number | null;
}

/**
 * Polygon's `frequency` integer is a payments-per-year count when it is a real
 * cadence (1 = annual, 2 = semi-annual, 4 = quarterly, 12 = monthly). 0 = one-
 * time and null are not usable cadences → return null so the caller falls back
 * to ex-date spacing.
 */
export function paymentsPerYearFromFrequency(freq: number | null): number | null {
  return freq === 1 || freq === 2 || freq === 4 || freq === 12 ? freq : null;
}

/**
 * Infer payments-per-year from the median spacing of recent (newest-first)
 * regular ex-dates: pick the cadence in {12,4,2,1} whose expected gap 365/n is
 * closest to the observed median gap (~30d→12, ~91d→4, ~182d→2, ~365d→1).
 * Needs at least two ex-dates to form a gap; returns null otherwise.
 */
export function paymentsPerYearFromSpacing(regular: DivHistItem[]): number | null {
  const dates = regular
    .map((d) => (d.exDividendDate ? Date.parse(d.exDividendDate) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a);
  if (dates.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 0; i < dates.length - 1; i++) {
    gaps.push((dates[i] - dates[i + 1]) / 86_400_000);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median =
    gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
  if (!(median > 0)) return null;
  let best: number | null = null;
  let bestErr = Infinity;
  for (const n of [12, 4, 2, 1]) {
    const err = Math.abs(median - 365 / n);
    if (err < bestErr) {
      bestErr = err;
      best = n;
    }
  }
  return best;
}

/**
 * FORWARD-ANNUALIZED dividend per share from a ticker's dividend history
 * (newest-first, as Polygon returns it):
 *   perShare = (most-recent REGULAR per-payment amount) × (payments per year).
 * Special / one-time distributions are excluded from both the per-payment amount
 * and the spacing; cashAmount is read null-safe. Returns null when neither the
 * frequency nor the ex-date spacing determines a cadence, so the caller leaves
 * dividendYield null rather than falling back to a (misleading) TTM sum.
 */
export function forwardAnnualDividend(
  history: DivHistItem[],
): { perShare: number; paymentsPerYear: number } | null {
  const regular = history.filter(
    (d) =>
      (d.cashAmount ?? 0) > 0 &&
      d.frequency !== 0 &&
      !(d.dividendType != null && SPECIAL_DIVIDEND_TYPES.has(d.dividendType)),
  );
  if (regular.length === 0) return null;

  // history is newest-first, so the first regular row is the latest payment.
  const perPayment = regular[0].cashAmount ?? 0;
  if (!(perPayment > 0)) return null;

  const paymentsPerYear =
    paymentsPerYearFromFrequency(regular[0].frequency) ??
    paymentsPerYearFromSpacing(regular);
  if (paymentsPerYear == null) return null;

  return { perShare: perPayment * paymentsPerYear, paymentsPerYear };
}
