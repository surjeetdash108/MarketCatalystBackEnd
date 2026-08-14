import { FmpService } from "../vendors/fmp/fmp.service";

/**
 * Analyst-ratings seam — Polygon has no analyst/ratings/consensus endpoint on
 * any tier, so `analyst-actions.job` is a no-op without this. Kept behind an
 * adapter so it is fully optional/removable: when ANALYST_SOURCE is "none"
 * (default) the token resolves to null and the job stays a no-op.
 *
 * The shape matches the frontend `AnalystConsensusDoc` (analyst.tsx / stock.tsx):
 * five rating tallies plus a consensus label.
 */

export interface AnalystConsensus {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  consensus: string | null;
}

export interface AnalystRatingsAdapter {
  readonly sourceName: string;
  /** Consensus for one ticker, or null when the vendor has no coverage. */
  getConsensus(ticker: string): Promise<AnalystConsensus | null>;
}

const n = (v: number | null | undefined): number =>
  typeof v === "number" ? v : 0;

/** FMP-backed ratings via /api/v4/upgrades-downgrades-consensus (per ticker). */
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
    return {
      strongBuy: n(row.strongBuy),
      buy: n(row.buy),
      hold: n(row.hold),
      sell: n(row.sell),
      strongSell: n(row.strongSell),
      consensus: row.consensus ?? null,
    };
  }
}
