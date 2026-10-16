import {
  computeQuarterFcf,
  computeTtmFcf,
} from "../../../MarketCatalystUI/app/iq/types/financials";

describe("computeQuarterFcf", () => {
  it("uses valid provider-sourced freeCashFlow when available", () => {
    const q = { freeCashFlow: 1500000, operatingCashFlow: 2000000, capitalExpenditures: -500000 };
    expect(computeQuarterFcf(q)).toBe(1500000);
  });

  it("calculates operatingCashFlow - abs(capitalExpenditures) when freeCashFlow is absent", () => {
    const qWithNegCapex = { operatingCashFlow: 2000000, capitalExpenditures: -500000 };
    expect(computeQuarterFcf(qWithNegCapex)).toBe(1500000);

    const qWithPosCapex = { operatingCashFlow: 2000000, capitalExpenditures: 500000 };
    expect(computeQuarterFcf(qWithPosCapex)).toBe(1500000);
  });

  it("returns null when freeCashFlow is missing and operatingCashFlow is missing", () => {
    const q = { capitalExpenditures: -500000 };
    expect(computeQuarterFcf(q)).toBeNull();
  });

  it("returns null when freeCashFlow is missing and capitalExpenditures is missing", () => {
    const q = { operatingCashFlow: 2000000 };
    expect(computeQuarterFcf(q)).toBeNull();
  });

  it("rejects non-finite freeCashFlow inputs (NaN, Infinity, -Infinity)", () => {
    expect(computeQuarterFcf({ freeCashFlow: NaN })).toBeNull();
    expect(computeQuarterFcf({ freeCashFlow: Infinity })).toBeNull();
    expect(computeQuarterFcf({ freeCashFlow: -Infinity })).toBeNull();
  });

  it("rejects non-finite operatingCashFlow or capitalExpenditures", () => {
    expect(computeQuarterFcf({ operatingCashFlow: NaN, capitalExpenditures: 100 })).toBeNull();
    expect(computeQuarterFcf({ operatingCashFlow: 100, capitalExpenditures: NaN })).toBeNull();
    expect(computeQuarterFcf({ operatingCashFlow: Infinity, capitalExpenditures: 100 })).toBeNull();
    expect(computeQuarterFcf({ operatingCashFlow: 100, capitalExpenditures: Infinity })).toBeNull();
  });

  it("returns null when all cash flow fields are null or empty", () => {
    expect(computeQuarterFcf({})).toBeNull();
    expect(
      computeQuarterFcf({
        freeCashFlow: null,
        operatingCashFlow: null,
        capitalExpenditures: null,
      }),
    ).toBeNull();
  });
});

describe("computeTtmFcf", () => {
  const completeQuarters = [
    { fiscalYear: "2024", fiscalPeriod: "Q3", endDate: "2024-09-30", freeCashFlow: 100 },
    { fiscalYear: "2024", fiscalPeriod: "Q4", endDate: "2024-12-31", freeCashFlow: 200 },
    { fiscalYear: "2025", fiscalPeriod: "Q1", endDate: "2025-03-31", freeCashFlow: 300 },
    { fiscalYear: "2025", fiscalPeriod: "Q2", endDate: "2025-06-30", freeCashFlow: 400 },
  ];

  it("successfully aggregates 4 complete quarters", () => {
    expect(computeTtmFcf(completeQuarters)).toBe(1000);
  });

  it("aggregates quarters using fallback operatingCashFlow - abs(CapEx)", () => {
    const mixedQuarters = [
      { fiscalYear: "2024", fiscalPeriod: "Q3", endDate: "2024-09-30", freeCashFlow: 100 },
      { fiscalYear: "2024", fiscalPeriod: "Q4", endDate: "2024-12-31", operatingCashFlow: 250, capitalExpenditures: -50 },
      { fiscalYear: "2025", fiscalPeriod: "Q1", endDate: "2025-03-31", freeCashFlow: 300 },
      { fiscalYear: "2025", fiscalPeriod: "Q2", endDate: "2025-06-30", operatingCashFlow: 500, capitalExpenditures: 100 },
    ];
    expect(computeTtmFcf(mixedQuarters)).toBe(1000);
  });

  it("returns null if fewer than 4 quarters are provided", () => {
    expect(computeTtmFcf(null)).toBeNull();
    expect(computeTtmFcf(undefined)).toBeNull();
    expect(computeTtmFcf([])).toBeNull();
    expect(computeTtmFcf(completeQuarters.slice(0, 3))).toBeNull();
  });

  it("returns null if quarters do not have 4 distinct periods (duplicate quarters)", () => {
    const duplicateQuarters = [
      { fiscalYear: "2024", fiscalPeriod: "Q3", endDate: "2024-09-30", freeCashFlow: 100 },
      { fiscalYear: "2024", fiscalPeriod: "Q3", endDate: "2024-09-30", freeCashFlow: 200 },
      { fiscalYear: "2025", fiscalPeriod: "Q1", endDate: "2025-03-31", freeCashFlow: 300 },
      { fiscalYear: "2025", fiscalPeriod: "Q2", endDate: "2025-06-30", freeCashFlow: 400 },
    ];
    expect(computeTtmFcf(duplicateQuarters)).toBeNull();
  });

  it("returns null (unavailable) rather than substituting zero if any quarter lacks sufficient data", () => {
    const missingOneQuarterFcf = [
      { fiscalYear: "2024", fiscalPeriod: "Q3", endDate: "2024-09-30", freeCashFlow: 100 },
      { fiscalYear: "2024", fiscalPeriod: "Q4", endDate: "2024-12-31", freeCashFlow: null, operatingCashFlow: null },
      { fiscalYear: "2025", fiscalPeriod: "Q1", endDate: "2025-03-31", freeCashFlow: 300 },
      { fiscalYear: "2025", fiscalPeriod: "Q2", endDate: "2025-06-30", freeCashFlow: 400 },
    ];
    // Under previous defect, this would have returned 800 (treating missing quarter as 0).
    expect(computeTtmFcf(missingOneQuarterFcf)).toBeNull();
  });

  it("returns null if a quarter has operatingCashFlow but missing CapEx", () => {
    const missingCapex = [
      { fiscalYear: "2024", fiscalPeriod: "Q3", endDate: "2024-09-30", freeCashFlow: 100 },
      { fiscalYear: "2024", fiscalPeriod: "Q4", endDate: "2024-12-31", operatingCashFlow: 250, capitalExpenditures: null },
      { fiscalYear: "2025", fiscalPeriod: "Q1", endDate: "2025-03-31", freeCashFlow: 300 },
      { fiscalYear: "2025", fiscalPeriod: "Q2", endDate: "2025-06-30", freeCashFlow: 400 },
    ];
    expect(computeTtmFcf(missingCapex)).toBeNull();
  });

  it("returns null if a quarter has CapEx but missing operatingCashFlow", () => {
    const missingOperatingCf = [
      { fiscalYear: "2024", fiscalPeriod: "Q3", endDate: "2024-09-30", freeCashFlow: 100 },
      { fiscalYear: "2024", fiscalPeriod: "Q4", endDate: "2024-12-31", operatingCashFlow: null, capitalExpenditures: -50 },
      { fiscalYear: "2025", fiscalPeriod: "Q1", endDate: "2025-03-31", freeCashFlow: 300 },
      { fiscalYear: "2025", fiscalPeriod: "Q2", endDate: "2025-06-30", freeCashFlow: 400 },
    ];
    expect(computeTtmFcf(missingOperatingCf)).toBeNull();
  });

  it("returns null if any quarter has non-finite inputs", () => {
    const nanQuarter = [
      { fiscalYear: "2024", fiscalPeriod: "Q3", endDate: "2024-09-30", freeCashFlow: 100 },
      { fiscalYear: "2024", fiscalPeriod: "Q4", endDate: "2024-12-31", freeCashFlow: NaN },
      { fiscalYear: "2025", fiscalPeriod: "Q1", endDate: "2025-03-31", freeCashFlow: 300 },
      { fiscalYear: "2025", fiscalPeriod: "Q2", endDate: "2025-06-30", freeCashFlow: 400 },
    ];
    expect(computeTtmFcf(nanQuarter)).toBeNull();
  });

  it("ensures FCF Yield is unavailable (null) when TTM FCF is incomplete", () => {
    const incompleteQuarters = [
      { fiscalYear: "2024", fiscalPeriod: "Q3", endDate: "2024-09-30", freeCashFlow: 100 },
      { fiscalYear: "2024", fiscalPeriod: "Q4", endDate: "2024-12-31", freeCashFlow: null },
      { fiscalYear: "2025", fiscalPeriod: "Q1", endDate: "2025-03-31", freeCashFlow: 300 },
      { fiscalYear: "2025", fiscalPeriod: "Q2", endDate: "2025-06-30", freeCashFlow: 400 },
    ];
    const ttmFcf = computeTtmFcf(incompleteQuarters);
    expect(ttmFcf).toBeNull();
    const marketCap = 50000000000;
    const fcfYield = (ttmFcf != null && marketCap != null && Number.isFinite(marketCap) && marketCap > 0)
      ? (ttmFcf / marketCap) * 100
      : null;
    expect(fcfYield).toBeNull();
  });
});
