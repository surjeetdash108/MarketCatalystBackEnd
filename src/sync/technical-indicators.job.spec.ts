import {
  anchor52wToPrice,
  computeIndicators,
  IndicatorBar,
  lastCompletedSession,
} from "./technical-indicators.job";

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

// SPY closes keyed by date: marks which sessions the market has completed.
const spy = (...dates: string[]) => new Map(dates.map((d) => [d, 500]));

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

describe("anchor52wToPrice", () => {
  it("measures distance from the displayed price, not the last bar close", () => {
    // MSFT 2026-10-12: bars end 10-09 (close 535.06), price is the 10-12 close.
    const doc = anchor52wToPrice({
      price: 541.15,
      high52: 553.72,
      low52: 349.2,
      pctFromHigh52: -3.37,
      pctFromLow52: 53.23,
    });
    expect(doc.high52).toBe(553.72);
    expect(doc.pctFromHigh52).toBe(-2.27);
    expect(doc.pctFromLow52).toBe(54.97);
  });

  it("extends the range when price is past a stored extreme", () => {
    const hi = anchor52wToPrice({ price: 112, high52: 110.13, low52: 60.07 });
    expect(hi.high52).toBe(112);
    expect(hi.pctFromHigh52).toBe(0);
    const lo = anchor52wToPrice({ price: 50, high52: 110.13, low52: 60.07 });
    expect(lo.low52).toBe(50);
    expect(lo.pctFromLow52).toBe(0);
  });

  it("leaves docs without a usable price or range untouched", () => {
    const noPrice = { price: null, high52: 10, pctFromHigh52: -5 };
    expect(anchor52wToPrice(noPrice)).toBe(noPrice);
    const noRange = anchor52wToPrice({ price: 10, high52: null, low52: null });
    expect(noRange.pctFromHigh52).toBeUndefined();
    expect(noRange.high52).toBeNull();
  });
});

describe("computeIndicators — rvol freshness", () => {
  // makeBars() ends on 2026-03-01.
  it("publishes rvol when the newest bar is the last completed session", () => {
    const ind = computeIndicators(makeBars(), spy("2026-02-28", "2026-03-01"), NOW)!;
    expect(ind.rvol).toEqual(expect.any(Number));
  });

  it("nulls rvol when the market has completed a newer session than the bars", () => {
    const ind = computeIndicators(makeBars(), spy("2026-03-01", "2026-03-02"), NOW)!;
    expect(ind.rvol).toBeNull();
  });

  it("nulls rvol on a still-forming bar for today", () => {
    // 10:00 ET on 2026-03-01, the newest bar's own date.
    const ind = computeIndicators(
      makeBars(),
      spy("2026-02-28"),
      new Date("2026-03-01T15:00:00Z"),
    )!;
    expect(ind.rvol).toBeNull();
  });
});

describe("lastCompletedSession", () => {
  it("takes SPY's newest completed session, so holidays need no calendar", () => {
    // Tue 2026-09-08 09:00 ET, the day after Labor Day: SPY's newest is Fri.
    expect(
      lastCompletedSession(spy("2026-09-03", "2026-09-04"), new Date("2026-09-08T13:00:00Z")),
    ).toBe("2026-09-04");
  });

  it("ignores SPY's bar for today until the regular session closes", () => {
    const m = spy("2026-10-15", "2026-10-16");
    expect(lastCompletedSession(m, new Date("2026-10-16T14:00:00Z"))).toBe("2026-10-15");
    expect(lastCompletedSession(m, new Date("2026-10-16T20:30:00Z"))).toBe("2026-10-16");
  });

  it("falls back to the most recent weekday without SPY closes", () => {
    // Mon 2026-10-19: before the close it is Fri, after it is Mon.
    expect(lastCompletedSession(new Map(), new Date("2026-10-19T13:00:00Z"))).toBe("2026-10-16");
    expect(lastCompletedSession(new Map(), new Date("2026-10-19T21:00:00Z"))).toBe("2026-10-19");
  });
});
