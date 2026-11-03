import { pickYearAgoByReportDate } from "./earnings-year-ago.util";

const q = (endDate: string, eps: number | null, rev: number | null) => ({
  endDate,
  epsActualReported: eps,
  revenue: rev,
});

const history = [
  q("2025-03-31", 1.1, 100),
  q("2025-06-30", 1.2, 110),
  q("2025-09-30", 1.3, 120),
  q("2025-12-31", 1.4, 130),
  q("2026-03-31", 1.5, 140),
  q("2026-06-30", 1.6, 150),
];

describe("pickYearAgoByReportDate", () => {
  it("picks the quarter ending a year before a typical report (Q3-2026 reported late Oct -> Q3-2025)", () => {
    expect(pickYearAgoByReportDate(history, "2026-10-29")).toEqual({ eps: 1.3, rev: 120 });
  });

  it("still picks the right quarter when reported only ~2 weeks after quarter-end", () => {
    expect(pickYearAgoByReportDate(history, "2026-10-14")).toEqual({ eps: 1.3, rev: 120 });
  });

  it("handles a late (10-K style) report ~85 days after quarter-end", () => {
    const withQ4 = [q("2024-12-31", 1.0, 90), ...history];
    expect(pickYearAgoByReportDate(withQ4, "2026-03-26")).toEqual({ eps: 1.0, rev: 90 });
  });

  it("returns null rather than a stale quarter when history has a gap", () => {
    expect(pickYearAgoByReportDate([q("2024-03-31", 1, 1)], "2026-10-29")).toBeNull();
  });

  it("returns null when the matched quarter has neither EPS nor revenue", () => {
    expect(pickYearAgoByReportDate([q("2025-09-30", null, null)], "2026-10-29")).toBeNull();
  });

  it("returns null for an unparseable date or empty history", () => {
    expect(pickYearAgoByReportDate(history, "not-a-date")).toBeNull();
    expect(pickYearAgoByReportDate([], "2026-10-29")).toBeNull();
  });
});
