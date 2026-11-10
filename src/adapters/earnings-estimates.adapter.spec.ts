import { FmpEarningsEstimatesAdapter } from "./earnings-estimates.adapter";
import type { FmpService } from "../vendors/fmp/fmp.service";

const row = (date: string, actual: number | null, est: number | null) => ({
  date, symbol: "X", actualEarningResult: actual, estimatedEarning: est, revenueActual: null, revenueEstimated: null,
});

describe("FmpEarningsEstimatesAdapter.getQuarterlyEstimates", () => {
  const adapter = (rows: ReturnType<typeof row>[]) =>
    new FmpEarningsEstimatesAdapter({ getEarningsSurprises: async () => rows } as unknown as FmpService);

  it("pairs a fiscal-year-end quarter reported with the 10-K up to ~90 days later (MCFT, day 72)", async () => {
    const q = await adapter([row("2026-11-05", null, 0.44), row("2026-09-10", 0.67, 0.63), row("2026-05-07", 0.45, 0.36)])
      .getQuarterlyEstimates("MCFT");
    expect(q.epsActualFor("2026-06-30")).toBe(0.67);
    expect(q.epsEstimateFor("2026-06-30")).toBe(0.63);
  });

  it("takes the nearest report, never the following quarter's", async () => {
    const q = await adapter([row("2026-10-20", 1.1, 1.0), row("2026-07-25", 0.9, 0.8)]).getQuarterlyEstimates("Y");
    expect(q.epsActualFor("2026-06-30")).toBe(0.9);
    expect(q.epsActualFor("2026-09-30")).toBe(1.1);
  });
});
