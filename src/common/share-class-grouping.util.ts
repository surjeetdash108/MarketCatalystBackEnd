/**
 * Deduplicates multiple share classes for the same issuer (e.g. GOOG and GOOGL)
 * by grouping by SEC CIK.
 *
 * For issuers with multiple share classes listed, keeps the primary / largest market cap ticker.
 * This fixes the heatmap showing the same company multiple times (e.g. GOOG 3 times).
 */

export interface ConstituentItem {
  ticker: string;
  marketCap?: number | null;
  pctChange?: number | null;
  cik?: string | null;
  [key: string]: unknown;
}

export function groupShareClassesByCik<T extends ConstituentItem>(
  constituents: T[],
): T[] {
  const map = new Map<string, T>();

  for (const item of constituents) {
    if (!item.ticker) continue;
    // Normalized CIK key, or fallback to ticker if CIK is absent
    const key = item.cik ? `CIK_${String(item.cik).replace(/^0+/, "")}` : `TKR_${item.ticker}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
    } else {
      // Retain the one with larger market cap
      const existingCap = existing.marketCap ?? 0;
      const currentCap = item.marketCap ?? 0;
      if (currentCap > existingCap) {
        map.set(key, item);
      }
    }
  }

  return [...map.values()].sort(
    (a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0),
  );
}
