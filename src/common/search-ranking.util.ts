export interface RankedSearchCandidate {
  ticker: string;
  name?: string | null;
}

/**
 * Ranked search candidates:
 * 1. Exact ticker match (case-insensitive)
 * 2. Ticker prefix match
 * 3. Name prefix match
 * 4. Substring / name match
 */
export function rankSearchCandidates<T extends RankedSearchCandidate>(
  candidates: T[],
  rawQuery: string,
): T[] {
  const q = rawQuery.trim();
  if (!q) return candidates;
  const upper = q.toUpperCase();
  const lower = q.toLowerCase();

  const exact: T[] = [];
  const tickerPrefix: T[] = [];
  const namePrefix: T[] = [];
  const substring: T[] = [];

  for (const c of candidates) {
    const sym = (c.ticker ?? "").toUpperCase();
    const nameLower = (c.name ?? "").toLowerCase();

    if (sym === upper) {
      exact.push(c);
    } else if (sym.startsWith(upper)) {
      tickerPrefix.push(c);
    } else if (nameLower.startsWith(lower)) {
      namePrefix.push(c);
    } else if (nameLower.includes(lower) || sym.includes(upper)) {
      substring.push(c);
    }
  }

  return [...exact, ...tickerPrefix, ...namePrefix, ...substring];
}
