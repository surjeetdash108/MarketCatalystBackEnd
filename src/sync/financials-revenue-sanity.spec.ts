import {
  nullImplausibleRevenue,
  type AnnualFinancials,
  type QuarterFinancials,
} from "./financials.job";

const B = 1e9;
const q = (
  fiscalYear: string,
  fiscalPeriod: string,
  revenueB: number | null,
  eps = 0.5,
): QuarterFinancials =>
  ({
    fiscalYear,
    fiscalPeriod,
    endDate: `${fiscalYear}-01-31`,
    revenue: revenueB == null ? null : revenueB * B,
    epsActual: eps,
  }) as unknown as QuarterFinancials;
const a = (fiscalYear: string, revenueB: number | null): AnnualFinancials =>
  ({
    fiscalYear,
    endDate: `${fiscalYear}-10-31`,
    revenue: revenueB == null ? null : revenueB * B,
  }) as unknown as AnnualFinancials;

describe("nullImplausibleRevenue", () => {
  it("A: HPE FY2026 — a bad full year turns the derived Q4 negative; both revenues are blanked, EPS is kept", () => {
    // As stored on 23 Nov 2026: Q4 = 14.547 − (9.301 + 10.678 + 12.213) = −17.645.
    const quarters = [
      q("2026", "Q1", 9.301),
      q("2026", "Q2", 10.678),
      q("2026", "Q3", 12.213),
      q("2026", "Q4", -17.645, -0.55),
    ];
    const annual = [a("2026", 14.547), a("2025", 34.296)];
    const fixes = nullImplausibleRevenue(quarters, annual);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatch(
      /FY2026: Q4 revenue -17\.6\dB with full year 14\.55B/,
    );
    expect(quarters[3].revenue).toBeNull();
    expect(quarters[3].epsActual).toBe(-0.55); // a real negative EPS stays
    expect(annual[0].revenue).toBeNull();
    expect(annual[1].revenue).toBe(34.296 * B); // other years untouched
    expect(quarters.slice(0, 3).map((x) => x.revenue)).toEqual([
      9.301 * B,
      10.678 * B,
      12.213 * B,
    ]);
  });

  it("B: FERG — full year under half of its four positive quarters; only the full year is blanked", () => {
    const quarters = [
      q("2026", "Q1", 7.6),
      q("2026", "Q2", 7.9),
      q("2026", "Q3", 8.1),
      q("2026", "Q4", 8.29),
    ];
    const annual = [a("2026", 8.75)];
    const fixes = nullImplausibleRevenue(quarters, annual);
    expect(fixes).toHaveLength(1);
    expect(annual[0].revenue).toBeNull();
    expect(quarters.every((x) => x.revenue != null)).toBe(true);
  });

  it("leaves a company that genuinely reports a negative quarter alone", () => {
    // Crypto-miner style: a negative quarter, but the full year is the sum of its parts and Q1–Q3 are not all positive.
    const quarters = [
      q("2024", "Q1", 0.1),
      q("2024", "Q2", -0.04),
      q("2024", "Q3", 0.2),
      q("2024", "Q4", 0.3),
    ];
    const annual = [a("2024", 0.56)];
    expect(nullImplausibleRevenue(quarters, annual)).toEqual([]);
    expect(quarters[1].revenue).toBe(-0.04 * B);
    expect(annual[0].revenue).toBe(0.56 * B);
  });

  it("leaves a negative Q4 alone when the full year is consistent with it (Q4 negative, year ≥ nine months)", () => {
    const quarters = [
      q("2025", "Q1", 1),
      q("2025", "Q2", 1),
      q("2025", "Q3", 1),
      q("2025", "Q4", -0.2),
    ];
    expect(nullImplausibleRevenue(quarters, [a("2025", 3.5)])).toEqual([]);
    expect(quarters[3].revenue).toBe(-0.2 * B);
  });

  it("leaves ordinary restatement gaps alone (full year a few percent below the quarters)", () => {
    const quarters = [
      q("2025", "Q1", 2.0),
      q("2025", "Q2", 2.1),
      q("2025", "Q3", 2.1),
      q("2025", "Q4", 2.07),
    ];
    const annual = [a("2025", 7.71 - 0.1)]; // 8.27 of quarters vs 7.61 → ~8% under, not half
    expect(nullImplausibleRevenue(quarters, annual)).toEqual([]);
    expect(annual[0].revenue).toBeCloseTo(7.61 * B);
  });

  it("does nothing for a year with no full-year row, an incomplete year, or missing revenue", () => {
    const noAnnual = [
      q("2026", "Q1", 9),
      q("2026", "Q2", 10),
      q("2026", "Q3", 12),
      q("2026", "Q4", -17),
    ];
    expect(nullImplausibleRevenue(noAnnual, [])).toEqual([]);
    expect(noAnnual[3].revenue).toBe(-17 * B);

    const partial = [q("2026", "Q1", 9), q("2026", "Q2", 10)];
    expect(nullImplausibleRevenue(partial, [a("2026", 1)])).toEqual([]);

    const nullRev = [
      q("2026", "Q1", 9),
      q("2026", "Q2", null),
      q("2026", "Q3", 12),
      q("2026", "Q4", -17),
    ];
    expect(nullImplausibleRevenue(nullRev, [a("2026", null)])).toEqual([]);
  });

  it("is idempotent: a second pass over already-blanked rows finds nothing", () => {
    const quarters = [
      q("2026", "Q1", 9.3),
      q("2026", "Q2", 10.7),
      q("2026", "Q3", 12.2),
      q("2026", "Q4", -17.6),
    ];
    const annual = [a("2026", 14.5)];
    expect(nullImplausibleRevenue(quarters, annual)).toHaveLength(1);
    expect(nullImplausibleRevenue(quarters, annual)).toEqual([]);
  });
});
