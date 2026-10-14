import {
  applyCalendarEstimates,
  type CalendarEstimate,
  type EpsHistoryRow,
  type QuarterFinancials,
} from "./financials.job";

/**
 * The chart/tables and the earnings calendar must show the SAME estimate for a
 * report, or one says beat while the other says miss (JNJ Q3 2026: calendar
 * 2.72 → miss, chart 2.52 → beat, against an actual of 2.59).
 */

const quarter = (q: Partial<QuarterFinancials>): QuarterFinancials =>
  ({
    fiscalPeriod: null,
    fiscalYear: null,
    endDate: null,
    filingDate: null,
    epsActual: null,
    epsEstimate: null,
    epsActualReported: null,
    epsEstimateReported: null,
    ...q,
  }) as QuarterFinancials;

const hist = (h: Partial<EpsHistoryRow>): EpsHistoryRow => ({
  fiscalYear: 2026,
  fiscalPeriod: "Q3",
  date: "2026-10-13",
  epsActual: null,
  epsEstimate: null,
  ...h,
});

describe("applyCalendarEstimates", () => {
  it("replaces FMP's surprise estimate with the calendar's (JNJ Q3 2026)", () => {
    const quarters = [
      quarter({
        fiscalPeriod: "Q3", fiscalYear: "2026", endDate: "2026-09-30",
        epsActualReported: 2.59, epsEstimate: 2.52, epsEstimateReported: 2.52,
      }),
    ];
    const epsHistory = [hist({ epsActual: 2.59, epsEstimate: 2.52 })];
    const calendar: CalendarEstimate[] = [
      { date: "2026-10-13", epsEstimate: 2.72, periodEnd: null },
    ];

    applyCalendarEstimates(quarters, epsHistory, calendar, []);

    expect(epsHistory[0].epsEstimate).toBe(2.72);
    expect(quarters[0].epsEstimate).toBe(2.72);
    expect(quarters[0].epsEstimateReported).toBe(2.72);
    // 2.59 vs 2.72 — the verdict now agrees with the calendar: a miss.
    expect(quarters[0].epsActualReported!).toBeLessThan(quarters[0].epsEstimateReported!);
  });

  it("tolerates a day or two between the calendar and surprise announce dates", () => {
    const epsHistory = [hist({ date: "2026-10-14", epsActual: 2.59, epsEstimate: 2.52 })];
    applyCalendarEstimates([], epsHistory, [{ date: "2026-10-13", epsEstimate: 2.72 }], []);
    expect(epsHistory[0].epsEstimate).toBe(2.72);
  });

  it("matches a 10-Q calendar row by period end", () => {
    const quarters = [
      quarter({ fiscalPeriod: "Q2", fiscalYear: "2026", endDate: "2026-06-28", epsEstimateReported: 2.8 }),
    ];
    const calendar: CalendarEstimate[] = [
      { date: "2026-07-23", epsEstimate: 2.85, periodEnd: "2026-06-29" },
    ];
    applyCalendarEstimates(quarters, [], calendar, []);
    expect(quarters[0].epsEstimateReported).toBe(2.85);
  });

  it("keeps FMP's estimate where the calendar has no row (older quarters)", () => {
    const quarters = [
      quarter({ fiscalPeriod: "Q1", fiscalYear: "2024", endDate: "2024-03-31", epsEstimate: 2.64, epsEstimateReported: 2.64 }),
    ];
    const epsHistory = [
      hist({ fiscalYear: 2024, fiscalPeriod: "Q1", date: "2024-04-16", epsActual: 2.71, epsEstimate: 2.64 }),
    ];
    applyCalendarEstimates(quarters, epsHistory, [{ date: "2026-10-13", epsEstimate: 2.72 }], []);
    expect(quarters[0].epsEstimateReported).toBe(2.64);
    expect(epsHistory[0].epsEstimate).toBe(2.64);
  });

  it("never matches the NEXT quarter's report to a quarter missing its own", () => {
    // Q2's report is not in the calendar; Q3's (2026-10-13) must not leak onto it.
    const quarters = [
      quarter({ fiscalPeriod: "Q2", fiscalYear: "2026", endDate: "2026-06-28", epsEstimateReported: 2.85 }),
    ];
    const epsHistory = [
      hist({ fiscalPeriod: "Q2", date: "2026-07-14", epsActual: 2.9, epsEstimate: 2.85 }),
      hist({ epsActual: 2.59, epsEstimate: 2.52 }),
    ];
    applyCalendarEstimates(quarters, epsHistory, [{ date: "2026-10-13", epsEstimate: 2.72 }], []);
    expect(quarters[0].epsEstimateReported).toBe(2.85);
    expect(epsHistory[0].epsEstimate).toBe(2.85);
  });

  it("is a no-op with an empty calendar", () => {
    const epsHistory = [hist({ epsActual: 2.59, epsEstimate: 2.52 })];
    applyCalendarEstimates([], epsHistory, [], []);
    expect(epsHistory[0].epsEstimate).toBe(2.52);
  });
});
