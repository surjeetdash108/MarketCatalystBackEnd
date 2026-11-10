import { DEFAULT_BACKTEST_YEARS, backtestStartDate } from "./universe-runner";

describe("universe runner backtest window", () => {
  it("defaults to 1 year (the Strategy Lab UI default since 62207de)", () => {
    expect(DEFAULT_BACKTEST_YEARS).toBe(1);
    expect(backtestStartDate("2026-11-06", undefined)).toBe("2025-11-06");
    expect(backtestStartDate("2026-11-06", 0)).toBe("2025-11-06");
  });
  it("uses the run's years when given", () => {
    expect(backtestStartDate("2026-11-06", 5)).toBe("2021-11-06");
  });
});
