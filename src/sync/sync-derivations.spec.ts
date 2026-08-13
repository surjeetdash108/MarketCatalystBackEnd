import { rsi, rsiSeries } from "./technical-indicators.job";
import {
  annualTotals,
  dividendCagr,
  increaseStreak,
} from "./corporate-actions.job";

/**
 * Covers the derivations that replaced fabricated UI values. These run on every
 * ticker nightly and feed panels users read as fact, so the invariants worth
 * pinning are the ones a subtle off-by-one would silently violate — a plausible
 * but wrong RSI line or dividend growth rate looks identical to a correct one.
 */

const div = (exDividendDate: string, cashAmount: number) => ({
  exDividendDate,
  cashAmount,
});

describe("rsiSeries", () => {
  // Deterministic sawtooth: enough movement in both directions that avgLoss
  // never hits zero, so the 100-clamp branch is not what is being measured.
  const closes = Array.from(
    { length: 120 },
    (_, i) => 100 + Math.sin(i / 3) * 8 + i * 0.15,
  );

  it("ends on the same value the scalar rsi() reports", () => {
    // The whole point of the series: it must be the same computation as the
    // existing scalar, unrolled. If these diverge, the pane and the "RSI (14)"
    // readout beside it would disagree on the same ticker.
    const series = rsiSeries(closes);
    expect(series.at(-1)).toBeCloseTo(rsi(closes), 10);
  });

  it("emits one value per bar after the seed window", () => {
    expect(rsiSeries(closes)).toHaveLength(closes.length - 14);
  });

  it("stays within the 0-100 bound", () => {
    for (const v of rsiSeries(closes)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("returns empty rather than throwing when history is too short", () => {
    expect(rsiSeries([1, 2, 3])).toEqual([]);
  });

  it("reports 100 for an unbroken advance", () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(rsiSeries(up).at(-1)).toBe(100);
  });
});

describe("annualTotals", () => {
  it("sums by calendar year of the ex-date, newest first", () => {
    const totals = annualTotals([
      div("2025-11-10", 0.26),
      div("2025-08-11", 0.26),
      div("2024-11-08", 0.25),
    ]);
    expect(totals).toEqual([
      { year: 2025, total: 0.52, payments: 2 },
      { year: 2024, total: 0.25, payments: 1 },
    ]);
  });

  it("ignores payments with no ex-date instead of bucketing them as NaN", () => {
    expect(annualTotals([{ exDividendDate: null, cashAmount: 1 }])).toEqual([]);
  });
});

describe("dividendCagr", () => {
  const thisYear = new Date().getUTCFullYear();
  /** `years` complete years ending last year, doubling once over the span. */
  const doubling = (span: number) =>
    Array.from({ length: span + 1 }, (_, i) => ({
      year: thisYear - 1 - i,
      total: 2 / 2 ** (i / span),
      payments: 4,
    }));

  it("computes growth across complete years only", () => {
    // 2.0 today from 1.0 five years back = 2^(1/5) - 1 = 14.87%.
    expect(dividendCagr(doubling(5), 5)).toBeCloseTo(14.87, 1);
  });

  it("excludes the current, partial year", () => {
    // A partial current year holding one payment would otherwise become the
    // "latest" and read as a savage cut every January.
    const withPartial = [
      { year: thisYear, total: 0.26, payments: 1 },
      ...doubling(5),
    ];
    expect(dividendCagr(withPartial, 5)).toBeCloseTo(14.87, 1);
  });

  it("returns null when there is not enough complete history", () => {
    expect(dividendCagr(doubling(2), 5)).toBeNull();
  });

  it("returns null rather than Infinity when the base year is zero", () => {
    const totals = [
      ...Array.from({ length: 5 }, (_, i) => ({
        year: thisYear - 1 - i,
        total: 1,
        payments: 4,
      })),
      { year: thisYear - 6, total: 0, payments: 0 },
    ];
    expect(dividendCagr(totals, 5)).toBeNull();
  });
});

describe("increaseStreak", () => {
  const thisYear = new Date().getUTCFullYear();
  const yearsOf = (totals: number[]) =>
    totals.map((total, i) => ({ year: thisYear - 1 - i, total, payments: 4 }));

  it("counts consecutive rising years", () => {
    expect(increaseStreak(yearsOf([1.3, 1.2, 1.1, 1.0]))).toBe(3);
  });

  it("stops at the first year that did not increase", () => {
    expect(increaseStreak(yearsOf([1.3, 1.2, 1.2, 1.0]))).toBe(1);
  });

  it("breaks the streak on a gap in the year sequence", () => {
    // 2 years missing in the middle: the years either side are not comparable,
    // so the streak must end rather than silently span the hole.
    const totals = [
      { year: thisYear - 1, total: 1.3, payments: 4 },
      { year: thisYear - 2, total: 1.2, payments: 4 },
      { year: thisYear - 5, total: 0.5, payments: 4 },
    ];
    expect(increaseStreak(totals)).toBe(1);
  });

  it("is zero for a single year of history", () => {
    expect(increaseStreak(yearsOf([1.0]))).toBe(0);
  });
});
