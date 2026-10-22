import { FearGreedJob } from "./fear-greed.job";

const make = (polygon: Record<string, unknown> = {}) =>
  new FearGreedJob(
    polygon as never,
    {} as never,
    {} as never,
    { register: jest.fn() } as never,
  ) as unknown as {
    componentsAt: (
      spy: number[],
      tlt: number[],
      vix: number[],
      i: number,
    ) => Record<string, number>;
    breadthVsPrevClose: (date: string | null) => Promise<number | null>;
  };

describe("FearGreedJob", () => {
  const flat = (n: number, v: number) => Array.from({ length: n }, () => v);

  it("reads a VIX spike as fear (VIX 24% over its 50-day average)", () => {
    const vix = [...flat(149, 15.8), 19.6];
    const c = make().componentsAt(flat(150, 100), flat(150, 100), vix, 149);
    expect(c.volatility).toBeLessThan(25);
    expect(c.momentum).toBe(50);
  });

  it("skips a part when an aligned close is missing instead of writing NaN", () => {
    const tlt = flat(150, 100);
    tlt[129] = NaN; // the 20-day base for index 149
    const c = make().componentsAt(flat(150, 100), tlt, flat(150, 16), 149);
    expect(c.safeHaven).toBeUndefined();
    expect(Object.values(c).every(Number.isFinite)).toBe(true);
  });

  it("measures breadth as close vs the PREVIOUS close", async () => {
    const day = (d: string) =>
      d === "2026-10-22"
        ? [
            { T: "A", c: 11 },
            { T: "B", c: 9 },
            { T: "C", c: 21 },
            { T: "D", c: 5 },
          ]
        : d === "2026-10-21"
          ? [
              { T: "A", c: 10 },
              { T: "B", c: 10 },
              { T: "C", c: 20 },
              { T: "D", c: 5 },
            ]
          : [];
    const job = make({
      getGroupedDaily: jest.fn((d: string) => Promise.resolve(day(d))),
      getLatestGroupedDaily: jest.fn((dates: string[]) => {
        const d = dates.find((x) => day(x).length > 0);
        return Promise.resolve(d ? { date: d, bars: day(d) } : null);
      }),
    });
    // A and C up, B down, D unchanged (excluded) → 2 of 3.
    await expect(job.breadthVsPrevClose("2026-10-22")).resolves.toBeCloseTo(
      66.67,
      1,
    );
  });
});
