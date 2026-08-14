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
    const [pt, summary, grades] = await Promise.all([
      this.fmp.getPriceTargetConsensus(ticker).catch(() => null),
      this.fmp.getPriceTargetSummary(ticker).catch(() => null),
      this.fmp.getGrades(ticker, GRADES_LIMIT).catch(() => []),
    ]);

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
      })),
    };
  }
}
