import { FmpService } from "../vendors/fmp/fmp.service";

/**
 * Analyst-ratings seam — Polygon has no analyst/ratings/consensus endpoint on
 * any tier, so `analyst-actions.job` is a no-op without this. Kept behind an
 * adapter so it is fully optional/removable: when ANALYST_SOURCE is "none"
 * (default) the token resolves to null and the job stays a no-op.
 *
 * The shape matches the frontend `AnalystConsensusDoc` (analyst.tsx / stock.tsx):
 * the five rating tallies + consensus label, plus (FMP) the price-target
 * consensus, its rolling-average trend, and the recent per-firm rating changes
 * that populate the "Per-firm analyst actions" feed.
 */

/** One per-firm rating change (upgrade/downgrade/initiate/maintain). */
export interface AnalystRatingChange {
  date: string;
  firm: string | null;
  previousGrade: string | null;
  newGrade: string | null;
  action: string | null;
  /** THIS firm's own 12-month price target (from FMP price-target-news, matched
   * by firm + nearest date). null when the firm posted no target — never the
   * ticker's consensus, so per-firm rows don't all show the same number. */
  priceTarget: number | null;
}

export interface AnalystConsensus {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  consensus: string | null;
  // ── Price target (12-month, across covering firms) ──
  priceTargetConsensus: number | null;
  priceTargetHigh: number | null;
  priceTargetLow: number | null;
  priceTargetMedian: number | null;
  // ── Price-target trend (rolling averages) ──
  ptAvgLastMonth: number | null;
  ptAvgLastQuarter: number | null;
  ptAvgLastYear: number | null;
  // ── Recent per-firm rating changes (newest first) ──
  recentGrades: AnalystRatingChange[];
}

export interface AnalystRatingsAdapter {
  readonly sourceName: string;
  /** Consensus + price target + recent grades for one ticker, or null when the
   * vendor has no coverage. */
  getConsensus(ticker: string): Promise<AnalystConsensus | null>;
}

const n = (v: number | null | undefined): number =>
  typeof v === "number" ? v : 0;

/** How many recent per-firm rating changes to keep per ticker. */
const GRADES_LIMIT = 8;

/**
 * A per-firm price target is only joined to a grade when the firm posted it
 * within this many days of the grade date. Beyond that the "nearest" target is a
 * separate, older call for a different thesis, and a stale number pinned to the
 * row is worse than showing none (BUG-DATA-012).
 */
const MAX_TARGET_AGE_DAYS = 45;

/** FMP-backed ratings: grades-consensus + price-target + grades (per ticker). */
export class FmpAnalystRatingsAdapter implements AnalystRatingsAdapter {
  readonly sourceName = "fmp";

  constructor(private readonly fmp: FmpService) {}

  async getConsensus(ticker: string): Promise<AnalystConsensus | null> {
    const row = await this.fmp.getAnalystConsensus(ticker);
    if (!row) return null;
    const total =
      n(row.strongBuy) +
      n(row.buy) +
      n(row.hold) +
      n(row.sell) +
      n(row.strongSell);
    if (total === 0) return null; // no coverage — leave the ticker untouched

    // Enrich a covered ticker with price target + recent grades. Each is
    // independent and best-effort: a miss degrades that field to null/[] rather
    // than dropping the whole (already-valid) consensus row.
    const [pt, summary, grades, targets] = await Promise.all([
      this.fmp.getPriceTargetConsensus(ticker).catch(() => null),
      this.fmp.getPriceTargetSummary(ticker).catch(() => null),
      this.fmp.getGrades(ticker, GRADES_LIMIT).catch(() => []),
      this.fmp.getPriceTargets(ticker).catch(() => []),
    ]);

    // Index each firm's posted targets (newest first) so a grade can pick up its
    // OWN firm's target near the grade date. Match on an EXACT normalized key:
    // the earlier prefix fallback ("k.startsWith(gk) || gk.startsWith(k)") could
    // collide between distinct firms (e.g. "Morgan" is a prefix of "Morgan
    // Stanley") and attach the wrong firm's target, so it is deliberately gone —
    // a firm whose name normalizes differently between the two FMP feeds simply
    // yields null rather than borrowing another firm's number (BUG-DATA-012).
    const norm = (s: string | null) =>
      (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const ptByFirm = new Map<string, Array<{ date: string; priceTarget: number }>>();
    for (const t of targets) {
      if (!t.firm || t.priceTarget == null) continue;
      const k = norm(t.firm);
      const list = ptByFirm.get(k) ?? [];
      list.push({ date: t.date, priceTarget: t.priceTarget });
      ptByFirm.set(k, list);
    }
    for (const list of ptByFirm.values())
      list.sort((a, b) => b.date.localeCompare(a.date));
    const targetFor = (firm: string | null, date: string): number | null => {
      const gk = norm(firm);
      if (!gk) return null;
      // Exact normalized-name match only — no prefix fallback (see above).
      const list = ptByFirm.get(gk);
      if (!list || list.length === 0) return null;
      const gradeTime = Date.parse(date);
      if (!Number.isFinite(gradeTime)) return null;
      const maxAgeMs = MAX_TARGET_AGE_DAYS * 86_400_000;
      // The target this firm posted CLOSEST to the grade date, but only within
      // ±MAX_TARGET_AGE_DAYS — a target months from the grade is a separate,
      // stale call, and null is preferred over pinning a wrong number to the row.
      let best: { date: string; priceTarget: number } | null = null;
      let bestDiff = Infinity;
      for (const p of list) {
        const diff = Math.abs(Date.parse(p.date) - gradeTime);
        if (Number.isFinite(diff) && diff <= maxAgeMs && diff < bestDiff) {
          bestDiff = diff;
          best = p;
        }
      }
      return best ? best.priceTarget : null;
    };

    return {
      strongBuy: n(row.strongBuy),
      buy: n(row.buy),
      hold: n(row.hold),
      sell: n(row.sell),
      strongSell: n(row.strongSell),
      consensus: row.consensus ?? null,
      priceTargetConsensus: pt?.targetConsensus ?? null,
      priceTargetHigh: pt?.targetHigh ?? null,
      priceTargetLow: pt?.targetLow ?? null,
      priceTargetMedian: pt?.targetMedian ?? null,
      ptAvgLastMonth: summary?.lastMonthAvg ?? null,
      ptAvgLastQuarter: summary?.lastQuarterAvg ?? null,
      ptAvgLastYear: summary?.lastYearAvg ?? null,
      recentGrades: grades.map((g) => ({
        date: g.date,
        firm: g.gradingCompany,
        previousGrade: g.previousGrade,
        newGrade: g.newGrade,
        action: g.action,
        priceTarget: targetFor(g.gradingCompany, g.date),
      })),
    };
  }
}
