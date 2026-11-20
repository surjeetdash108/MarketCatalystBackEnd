import { readFileSync } from "fs";
import { join } from "path";
import { clipLatePrintSpikes, type IntradayBar } from "./late-print-filter";

const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const hhmm = (t: number) => NY.format(new Date(t));
// Real Massive/Polygon 1-minute bars for ANT on its first full day (whole day, extended hours too).
const ant = (
  JSON.parse(
    readFileSync(
      join(__dirname, "fixtures/ant-2026-11-19-polygon-1m.json"),
      "utf-8",
    ),
  ) as { bars: IntradayBar[] }
).bars;

/** A flat, quiet run of 1-minute bars around $50 (body ±0.05), starting 10:00 ET Nov 19. */
function quiet(
  n: number,
  start = Date.UTC(2026, 10, 19, 15, 0),
): IntradayBar[] {
  return Array.from({ length: n }, (_, i) => {
    const o = 50 + (i % 2 ? 0.03 : -0.02);
    const c = 50 + (i % 2 ? -0.02 : 0.03);
    return {
      t: start + i * 60_000,
      o,
      h: Math.max(o, c) + 0.04,
      l: Math.min(o, c) - 0.04,
      c,
      v: 1000,
    };
  });
}

describe("clipLatePrintSpikes (late-reported prints in Polygon minute bars)", () => {
  it("ANT 2026-11-19: clips every fake mid-afternoon high (112.96 / 115.10 while trading at $95–99)", () => {
    const before = ant.filter(
      (b) => hhmm(b.t) >= "13:00" && hhmm(b.t) <= "16:00" && b.h >= 112.9,
    );
    expect(before.length).toBe(31); // the fixture really carries the spikes

    const out = clipLatePrintSpikes(ant);
    const after = out.filter(
      (b) => hhmm(b.t) >= "13:00" && hhmm(b.t) <= "16:00",
    );
    expect(Math.max(...after.map((b) => b.h))).toBeLessThan(100);
    for (const b of after)
      expect(b.h).toBeGreaterThanOrEqual(Math.max(b.o, b.c));
  });

  it("ANT: leaves the genuine opening-minute high (115.10 at 11:48) and every open/close untouched", () => {
    const out = clipLatePrintSpikes(ant);
    const open = out.find((b) => hhmm(b.t) === "11:48");
    expect(open?.h).toBe(115.1);
    out.forEach((b, i) => {
      expect(b.o).toBe(ant[i].o);
      expect(b.c).toBe(ant[i].c);
      expect(b.v).toBe(ant[i].v);
      expect(b.t).toBe(ant[i].t);
    });
  });

  it("does not touch a real 4% wick (below the 5% floor)", () => {
    const bars = quiet(30);
    bars[15] = { ...bars[15], l: Math.min(bars[15].o, bars[15].c) * 0.96 };
    expect(clipLatePrintSpikes(bars)[15].l).toBe(bars[15].l);
  });

  it("does not touch a big wick when the neighbours move just as much (volatile tape)", () => {
    // Bodies of ±$3 on a $50 stock: a $4 wick is under 10x the typical body.
    const bars = quiet(30).map((b, i) => ({
      ...b,
      o: 50 + (i % 2 ? 3 : -3),
      c: 50 + (i % 2 ? -3 : 3),
      h: 53.2,
      l: 46.8,
    }));
    bars[15] = { ...bars[15], h: 57.5 };
    expect(clipLatePrintSpikes(bars)[15].h).toBe(57.5);
  });

  it("clips an isolated 8% low print on a quiet tape to the bar's body", () => {
    const bars = quiet(30);
    bars[10] = { ...bars[10], l: 46 };
    const out = clipLatePrintSpikes(bars);
    expect(out[10].l).toBe(Math.min(bars[10].o, bars[10].c));
    expect(out[9]).toEqual(bars[9]);
  });

  it("compares only within the same New York session day (an overnight gap is not a spike)", () => {
    const day1 = quiet(20, Date.UTC(2026, 10, 18, 20, 30)); // ends ~15:50 ET Nov 18
    const day2 = quiet(20, Date.UTC(2026, 10, 19, 14, 30)).map((b) => ({
      ...b,
      o: b.o * 1.2,
      c: b.c * 1.2,
      h: b.h * 1.2,
      l: b.l * 1.2,
    }));
    const out = clipLatePrintSpikes([...day1, ...day2]);
    expect(out).toEqual([...day1, ...day2]);
  });

  it("returns the input unchanged for short or non-finite series", () => {
    expect(clipLatePrintSpikes([])).toEqual([]);
    const two = quiet(2);
    expect(clipLatePrintSpikes(two)).toEqual(two);
    const bad = quiet(10);
    bad[5] = { ...bad[5], h: Number.NaN };
    expect(clipLatePrintSpikes(bad)[5].h).toBeNaN();
  });
});
