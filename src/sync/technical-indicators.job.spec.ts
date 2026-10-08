import { computeIndicators, IndicatorBar } from "./technical-indicators.job";

// 60 daily bars with a wobble so RSI/MACD resolve (computeIndicators returns
// null without them). Dates are consecutive calendar days from 2026-01-01.
function makeBars(n = 60): IndicatorBar[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i * 0.5 + Math.sin(i) * 3;
    return {
      barDate: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000 + i,
    };
  });
}

// A fixed `now` well after the last bar, so no bar is treated as forming.
const NOW = new Date("2026-06-01T20:00:00Z");

describe("computeIndicators — week5Closes", () => {
  it("returns the last 6 dated closes, oldest → newest", () => {
    const bars = makeBars();
    const ind = computeIndicators(bars, new Map(), NOW)!;

    expect(ind.week5Closes).toHaveLength(6);
    const last6 = bars.slice(-6);
    ind.week5Closes!.forEach((c, i) => {
      expect(c.date).toBe(last6[i].barDate);
      expect(c.close).toBeCloseTo(last6[i].close, 4);
    });
  });

  it("starts at the same close as week5BaseClose", () => {
    const ind = computeIndicators(makeBars(), new Map(), NOW)!;
    expect(ind.week5Closes![0].close).toBe(ind.week5BaseClose);
  });

  it("rounds closes to 4 decimals", () => {
    const bars = makeBars();
    bars[bars.length - 1].close = 123.456789;
    const ind = computeIndicators(bars, new Map(), NOW)!;
    expect(ind.week5Closes![5].close).toBe(123.4568);
  });

  it("is null when any of the last 6 bars has no date", () => {
    const bars = makeBars();
    delete bars[bars.length - 3].barDate;
    const ind = computeIndicators(bars, new Map(), NOW)!;
    expect(ind.week5Closes).toBeNull();
    // The undated bar does not affect the move itself.
    expect(ind.week5ChangePct).not.toBeNull();
  });

  it("ignores a missing date outside the last 6 bars", () => {
    const bars = makeBars();
    delete bars[bars.length - 7].barDate;
    const ind = computeIndicators(bars, new Map(), NOW)!;
    expect(ind.week5Closes).toHaveLength(6);
  });
});
