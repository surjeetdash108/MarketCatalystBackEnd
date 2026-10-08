/**
 * Split a pool of quotes into top gainers and top losers.
 *
 * Every movers board used to rank the SAME pool twice (desc for gainers, asc
 * for losers) with no sign check. That only looks right while the pool is large
 * and two-sided: with ≤ topN rows both lists are the same tickers reversed, and
 * when every pctChange ties (all 0 outside the session, or not yet refreshed) a
 * stable sort leaves both lists in insertion order — byte-identical boards.
 *
 * Partitioning by sign first makes the lists disjoint by construction: a
 * gainer is strictly up, a loser strictly down, flat names are on neither, and
 * a flat or one-sided day yields a short/empty list instead of a mirrored one.
 */
export function splitMovers<T>(
  rows: readonly T[],
  pctOf: (row: T) => number | null | undefined,
  topN: number,
): { gainers: T[]; losers: T[] } {
  const up: Array<{ row: T; pct: number }> = [];
  const down: Array<{ row: T; pct: number }> = [];
  for (const row of rows) {
    const pct = pctOf(row);
    if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
    if (pct > 0) up.push({ row, pct });
    else if (pct < 0) down.push({ row, pct });
  }
  return {
    gainers: up
      .sort((a, b) => b.pct - a.pct)
      .slice(0, topN)
      .map((x) => x.row),
    losers: down
      .sort((a, b) => a.pct - b.pct)
      .slice(0, topN)
      .map((x) => x.row),
  };
}
