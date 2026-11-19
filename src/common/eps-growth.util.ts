/**
 * GAAP diluted EPS growth for the latest fiscal year, from the same FMP
 * income-statement-growth row the revenue growth comes from — so the
 * Earnings Acceleration screen's EPS and revenue figures share one basis
 * (Nov 19 workbook rows 9–10: MU +879% / DASH, TradingView FY diluted).
 * Fraction (8.79 = +879%); null when absent or beyond ±1000% (a near-zero
 * prior year is not a growth rate — the same cap the rest of the app uses).
 */
export function fyDilutedEpsGrowth(
  row: { growthEPSDiluted?: unknown } | null | undefined,
): number | null {
  const v = Number(row?.growthEPSDiluted);
  if (!Number.isFinite(v) || Math.abs(v) > 10) return null;
  return Math.round(v * 10000) / 10000;
}
