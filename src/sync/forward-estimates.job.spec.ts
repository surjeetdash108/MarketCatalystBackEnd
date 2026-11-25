import { nextFiscalYearEps } from "./forward-estimates.job";

describe("nextFiscalYearEps", () => {
  const rows = [
    { date: "2025-01-26", estimatedEpsAvg: 2.95 },
    { date: "2027-01-31", estimatedEpsAvg: 6.4 },
    { date: "2026-01-25", estimatedEpsAvg: 4.5 },
    { date: "2028-01-30", estimatedEpsAvg: 7.9 },
  ];
  it("picks the earliest fiscal year not yet ended", () => {
    expect(nextFiscalYearEps(rows, "2026-11-26")).toEqual({
      eps: 6.4,
      fyEnd: "2027-01-31",
    });
  });
  it("null when there is no forward estimate", () => {
    expect(nextFiscalYearEps(rows.slice(0, 1), "2026-11-26")).toBeNull();
    expect(
      nextFiscalYearEps(
        [{ date: "2027-01-31", estimatedEpsAvg: null }],
        "2026-11-26",
      ),
    ).toBeNull();
  });
});
