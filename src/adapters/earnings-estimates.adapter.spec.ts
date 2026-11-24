import { FmpEarningsEstimatesAdapter } from "./earnings-estimates.adapter";
import type { FmpService } from "../vendors/fmp/fmp.service";

const row = (
  date: string,
  actual: number | null,
  est: number | null,
  revenueActual: number | null = null,
  revenueEstimated: number | null = null,
) => ({
  date, symbol: "X", actualEarningResult: actual, estimatedEarning: est, revenueActual, revenueEstimated,
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

describe("FmpEarningsEstimatesAdapter revenue estimate pairing", () => {
  const adapter = (rows: ReturnType<typeof row>[]) =>
    new FmpEarningsEstimatesAdapter({ getEarningsSurprises: async () => rows } as unknown as FmpService);

  it("gives no revenue estimate for a report with no actual (ANT's pre-IPO placeholder row), but keeps the EPS estimate", async () => {
    // The two rows FMP returned for ANT on 24 Nov 2026: neither has an actual.
    const q = await adapter([
      row("2027-02-24", null, 0.07824, null, 21_303_120_000),
      row("2026-11-02", null, 0.255, null, 16_959_670_000),
    ]).getQuarterlyEstimates("ANT");
    // Sep-26 is 33 days before the 2 Nov row, so it pairs with it...
    expect(q.epsEstimateFor("2026-09-30")).toBe(0.255);
    // ...but there is no print, so no surprise baseline.
    expect(q.revenueEstimateFor("2026-09-30")).toBeNull();
  });

  it("lets the nearest report decide: a pending one is not skipped for a later report in the same window", async () => {
    // Both rows sit inside Jun-30's 92-day window. The nearest (day 20) has no
    // actual yet; the later one (day 77) has. Dropping no-actual rows BEFORE
    // picking the nearest would hand Jun-30 the later report's estimate.
    const q = await adapter([
      row("2026-09-15", 1.1, 1.0, 5_100, 5_000),
      row("2026-07-20", null, 0.9, null, 4_000),
    ]).getQuarterlyEstimates("Y");
    expect(q.revenueEstimateFor("2026-06-30")).toBeNull();
  });

  it("pairs once the report has an EPS actual", async () => {
    const q = await adapter([row("2026-11-05", 1.1, 1.0, null, 5_000)]).getQuarterlyEstimates("Y");
    expect(q.revenueEstimateFor("2026-09-30")).toBe(5_000);
  });

  it("pairs once the report has only a revenue actual", async () => {
    const q = await adapter([row("2026-11-05", null, 1.0, 5_100, 5_000)]).getQuarterlyEstimates("Y");
    expect(q.revenueEstimateFor("2026-09-30")).toBe(5_000);
  });
});
