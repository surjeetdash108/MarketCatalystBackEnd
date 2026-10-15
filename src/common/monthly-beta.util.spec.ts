import {
  BETA_MAX_RETURNS,
  BETA_MIN_RETURNS,
  computeMonthlyBeta,
  monthEndDates,
} from "./monthly-beta.util";

/** n consecutive month keys ending 2026-09: "2021-..", …, "2026-09". */
function monthsBack(n: number): string[] {
  const out: string[] = [];
  let y = 2026;
  let m = 9;
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-${String(m).padStart(2, "0")}`);
    if (--m === 0) {
      m = 12;
      y--;
    }
  }
  return out;
}

/** Closes compounding the given returns from a starting price. */
function series(
  months: string[],
  returns: number[],
  start = 100,
): Map<string, number> {
  const m = new Map<string, number>([[months[0], start]]);
  let px = start;
  returns.forEach((r, i) => {
    px *= 1 + r;
    m.set(months[i + 1], px);
  });
  return m;
}

/** A deterministic, non-constant market return path. */
const marketReturns = (n: number) =>
  Array.from({ length: n }, (_, i) => [0.02, -0.02, 0.03, -0.01, 0.015][i % 5]);

describe("monthEndDates", () => {
  it("keeps the last session per month and drops the current month", () => {
    const dates = [
      "2026-08-28",
      "2026-08-31",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-09",
    ];
    expect(monthEndDates(dates, "2026-10")).toEqual([
      "2026-08-31",
      "2026-09-30",
    ]);
  });

  it("is order-independent", () => {
    expect(monthEndDates(["2026-09-30", "2026-09-01"], "2026-10")).toEqual([
      "2026-09-30",
    ]);
  });
});

describe("computeMonthlyBeta", () => {
  const months = monthsBack(BETA_MAX_RETURNS + 1);
  const mkt = marketReturns(BETA_MAX_RETURNS);
  const market = series(months, mkt, 500);

  it("recovers a stock that moves exactly 1.5x the market", () => {
    const stock = series(
      months,
      mkt.map((r) => r * 1.5),
    );
    const out = computeMonthlyBeta(stock, market);
    expect(out.beta).toBeCloseTo(1.5, 3);
    expect(out.months).toBe(BETA_MAX_RETURNS);
    expect(out.r2).toBeCloseTo(1, 3);
  });

  it("matches the hand-worked 3-month example (scaled up to the minimum)", () => {
    // +2/−2/+3 market vs +3/−3/+4.5 stock → cov 21, var 14 → β 1.5.
    const base = [0.02, -0.02, 0.03];
    const m = monthsBack(BETA_MIN_RETURNS + 1);
    const r = Array.from({ length: BETA_MIN_RETURNS }, (_, i) => base[i % 3]);
    const out = computeMonthlyBeta(
      series(
        m,
        r.map((x) => x * 1.5),
      ),
      series(m, r, 500),
    );
    expect(out.beta).toBe(1.5);
  });

  it("uses only the newest 60 returns", () => {
    const long = monthsBack(BETA_MAX_RETURNS + 13);
    const r = marketReturns(BETA_MAX_RETURNS + 12);
    const out = computeMonthlyBeta(
      series(
        long,
        r.map((x) => x * 2),
      ),
      series(long, r, 500),
    );
    expect(out.months).toBe(BETA_MAX_RETURNS);
  });

  it("is null below the minimum history", () => {
    const m = monthsBack(BETA_MIN_RETURNS); // one return short
    const r = marketReturns(BETA_MIN_RETURNS - 1);
    expect(computeMonthlyBeta(series(m, r), series(m, r, 500))).toBeNull();
  });

  it("is null when the market never moved", () => {
    const flat = series(months, Array<number>(BETA_MAX_RETURNS).fill(0), 500);
    expect(computeMonthlyBeta(series(months, mkt), flat)).toBeNull();
  });

  it("spans a month the stock is missing on BOTH sides, not mismatched periods", () => {
    const stock = series(
      months,
      mkt.map((r) => r * 1.5),
    );
    stock.delete(months[30]);
    const out = computeMonthlyBeta(stock, market);
    expect(out.months).toBe(BETA_MAX_RETURNS - 1);
    expect(out.beta).toBeGreaterThan(1.4);
    expect(out.beta).toBeLessThan(1.6);
  });

  it("ignores non-positive or non-finite closes", () => {
    const stock = series(
      months,
      mkt.map((r) => r * 1.5),
    );
    stock.set(months[10], 0);
    stock.set(months[11], NaN);
    expect(computeMonthlyBeta(stock, market).months).toBe(BETA_MAX_RETURNS - 2);
  });

  it("drops history before a spin-off style >10x discontinuity", () => {
    const stock = series(
      months,
      mkt.map((r) => r * 1.5),
    );
    // Predecessor traded ~30x higher for the first 20 months.
    months.slice(0, 20).forEach((m) => stock.set(m, stock.get(m) * 30));
    const out = computeMonthlyBeta(stock, market);
    expect(out.months).toBe(BETA_MAX_RETURNS - 20);
    expect(out.beta).toBeCloseTo(1.5, 3);
  });
});
