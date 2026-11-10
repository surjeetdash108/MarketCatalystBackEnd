import { label, percentileScore, rawSeries, scoresAt } from "./fear-greed.job";

const flat = (n: number, v: number) => Array.from({ length: n }, () => v);
const nulls = (n: number) =>
  Array.from({ length: n }, (): number | null => null);

describe("Fear & Greed scoring", () => {
  it("scores a reading by its rank in the trailing year", () => {
    const raw = Array.from({ length: 100 }, (_, i) => i); // 0..99, rising
    expect(percentileScore(raw, 99)).toBeCloseTo(99.5, 1); // highest of 100
    expect(percentileScore([...raw.slice(0, 99), -1], 99)).toBeCloseTo(0.5, 1); // lowest
    expect(percentileScore(raw.slice(0, 30), 29)).toBeNull(); // too little history
  });

  it("reads a VIX spike as fear and a calm VIX as greed", () => {
    const n = 300;
    const base = {
      SPY: flat(n, 100),
      TLT: flat(n, 100),
      HYG: flat(n, 100),
      LQD: flat(n, 100),
    };
    // VIX wobbles 14-16, then spikes 24% over its average on the last day.
    const vix = Array.from({ length: n }, (_, i) => 15 + Math.sin(i));
    vix[n - 1] = 19.6;
    const spike = scoresAt(
      rawSeries({ ...base, "^VIX": vix }, nulls(n), nulls(n)),
      n - 1,
    );
    expect(spike.volatility).toBeLessThan(10);
    vix[n - 1] = 12;
    const calm = scoresAt(
      rawSeries({ ...base, "^VIX": vix }, nulls(n), nulls(n)),
      n - 1,
    );
    expect(calm.volatility).toBeGreaterThan(90);
  });

  it("ranks momentum against its own history, not a fixed scale", () => {
    // SPY rises 0.1%/day for a year (well above its 125-day average), then
    // stalls just 1% above it: high on a fixed scale, fear against its history.
    const n = 400;
    const spy = Array.from({ length: n }, (_, i) => 100 * 1.001 ** i);
    const ma = spy.slice(n - 126, n - 1).reduce((a, b) => a + b, 0) / 125;
    spy[n - 1] = ma * 1.01;
    const s = scoresAt(
      rawSeries(
        {
          SPY: spy,
          TLT: flat(n, 100),
          "^VIX": flat(n, 15),
          HYG: flat(n, 100),
          LQD: flat(n, 100),
        },
        nulls(n),
        nulls(n),
      ),
      n - 1,
    );
    expect(s.momentum).toBeLessThan(25);
  });

  it("leaves a part out when a price is missing rather than scoring NaN", () => {
    const n = 300;
    const tlt = flat(n, 100);
    tlt[n - 21] = NaN; // the 20-session base for the last day
    const s = scoresAt(
      rawSeries(
        {
          SPY: flat(n, 100),
          TLT: tlt,
          "^VIX": flat(n, 15),
          HYG: flat(n, 100),
          LQD: flat(n, 100),
        },
        nulls(n),
        nulls(n),
      ),
      n - 1,
    );
    expect(s.safeHaven).toBeUndefined();
    expect(Object.values(s).every(Number.isFinite)).toBe(true);
  });

  it("labels on the published bands", () => {
    expect([label(20), label(40), label(50), label(60), label(80)]).toEqual([
      "Extreme Fear",
      "Fear",
      "Neutral",
      "Greed",
      "Extreme Greed",
    ]);
  });
});
