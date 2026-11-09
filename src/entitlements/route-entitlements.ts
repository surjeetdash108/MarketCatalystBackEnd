/**
 * Entitlements for routes whose requirement depends on the request.
 *
 * /live/bars: daily ranges (3M, 6M, 1Y) are Free; minute-bar ranges need
 * chartsIntraday; the 5-year range needs chartsHistory.
 */
export const INTRADAY_TFS = new Set(["1H", "1D", "5D", "1W", "1M"]);

export function barsEntitlement(req: {
  query?: Record<string, unknown>;
}): string | null {
  const q = req.query ?? {};
  if (q.interval != null) return "chartsIntraday";
  const tf = String(q.tf ?? "")
    .toUpperCase()
    .trim();
  if (INTRADAY_TFS.has(tf)) return "chartsIntraday";
  if (tf === "5Y") return "chartsHistory";
  return null;
}
