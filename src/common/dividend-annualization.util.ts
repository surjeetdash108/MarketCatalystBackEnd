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
  exDividendDate?: string | null;
  cashAmount?: number | null;
  amount?: number | null;
  dividendType?: string | null;
  frequency?: number | null;
  declarationDate?: string | null;
  recordDate?: string | null;
  date?: string | null;
}

export function getDivAmount(d: DivHistItem): number {
  return d.cashAmount ?? d.amount ?? 0;
}

export function getDivDate(d: DivHistItem): string | null {
  return d.exDividendDate ?? d.declarationDate ?? d.recordDate ?? d.date ?? null;
}

/**
 * A recurring payment: neither one-time (`frequency` 0) nor a special /
 * capital-gains distribution. The forward run-rate, the growth rate and the
 * raise streak all describe this dividend, not the one-offs.
 */
export function isRegularDividend(
  d: Pick<DivHistItem, "dividendType" | "frequency">,
): boolean {
  return (
    d.frequency !== 0 &&
    !(d.dividendType != null && SPECIAL_DIVIDEND_TYPES.has(d.dividendType))
  );
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
    .map((d) => {
      const dt = getDivDate(d);
      return dt ? Date.parse(dt) : NaN;
    })
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
  nowMs = Date.now(),
): { perShare: number; paymentsPerYear: number } | null {
  const regular = history.filter(
    (d) => getDivAmount(d) > 0 && isRegularDividend(d),
  );
  if (regular.length === 0) return null;

  // history is newest-first, so the first regular row is the latest payment.
  const latest = regular[0];
  const perPayment = getDivAmount(latest);
  if (!(perPayment > 0)) return null;

  const paymentsPerYear =
    paymentsPerYearFromFrequency(latest.frequency ?? null) ??
    paymentsPerYearFromSpacing(regular);
  if (paymentsPerYear == null) return null;

  // Grace window: require latest ex-dividend date to be within 1 cadence period + 60 days.
  // If a company suspended its dividend years ago (e.g. BA or PLAY in 2020),
  // annualizing a multi-year-old dividend revived a suspended/dead yield.
  const exDateStr = getDivDate(latest);
  if (exDateStr) {
    const exTime = Date.parse(exDateStr);
    if (Number.isFinite(exTime)) {
      const expectedPeriodDays = Math.round(365 / paymentsPerYear);
      const maxAgeMs = (expectedPeriodDays + 60) * 86_400_000;
      if (nowMs - exTime > maxAgeMs) {
        return null;
      }
    }
  }

  return { perShare: perPayment * paymentsPerYear, paymentsPerYear };
}

export interface DividendYieldResult {
  forward: {
    perShare: number;
    yieldPct: number | null;
    paymentsPerYear: number;
  } | null;
  trailing: {
    perShare: number;
    yieldPct: number | null;
    paymentsCount: number;
  } | null;
  isPayer: boolean;
}

/**
 * Unified dividend yield resolver: returns both forward and trailing yields
 * with explicit labeling. Single source of truth across Key stats, Financials card,
 * and SI so they never disagree.
 */
export function resolveDividendYields(params: {
  history: DivHistItem[];
  price: number | null;
  nowMs?: number;
}): DividendYieldResult {
  const nowMs = params.nowMs ?? Date.now();
  const fwd = forwardAnnualDividend(params.history, nowMs);
  const forward = fwd
    ? {
        perShare: Math.round(fwd.perShare * 10000) / 10000,
        yieldPct:
          params.price != null && params.price > 0
            ? Math.round((fwd.perShare / params.price) * 10000) / 100
            : null,
        paymentsPerYear: fwd.paymentsPerYear,
      }
    : null;

  // Trailing twelve months (ex-dates within 365 days up to now)
  const oneYearAgoMs = nowMs - 365 * 86_400_000;
  const ttmItems = params.history.filter((d) => {
    const ds = getDivDate(d);
    if (!ds) return false;
    const t = Date.parse(ds);
    return Number.isFinite(t) && t >= oneYearAgoMs && t <= nowMs;
  });
  const ttmTotal = ttmItems.reduce((s, d) => s + getDivAmount(d), 0);
  const trailing =
    ttmItems.length > 0 && ttmTotal > 0
      ? {
          perShare: Math.round(ttmTotal * 10000) / 10000,
          yieldPct:
            params.price != null && params.price > 0
              ? Math.round((ttmTotal / params.price) * 10000) / 100
              : null,
          paymentsCount: ttmItems.length,
        }
      : null;

  return {
    forward,
    trailing,
    isPayer: forward != null,
  };
}
