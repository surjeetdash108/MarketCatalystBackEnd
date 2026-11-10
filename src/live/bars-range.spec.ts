import { sliceRange, type Candle } from "./bars-aggregate.util";

/** Extended-hours (04:00–20:00 ET) bars of `minutes` width on every weekday
 *  from `from` through `to` (ET dates). EDT (UTC−4) — dates below are in Oct. */
function extended(from: string, to: string, minutes: number): Candle[] {
  const out: Candle[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const start = d.getTime() + (4 + 4) * 3_600_000; // 04:00 ET = 08:00 UTC
    const end = d.getTime() + (20 + 4) * 3_600_000; // 20:00 ET
    for (let t = start; t < end; t += minutes * 60_000) {
      out.push({ t, o: 1, h: 1, l: 1, c: 1, v: 1, vw: null });
    }
  }
  return out;
}

const etDate = (t: number) => new Date(t - 4 * 3_600_000).toISOString().slice(0, 10);
const sessions = (bars: Candle[]) => [...new Set(bars.map((b) => etDate(b.t)))];

describe("sliceRange", () => {
  // Fri 16 Oct 2026 is the newest session.
  const fiveMin = extended("2026-10-05", "2026-10-16", 5);
  const thirtyMin = extended("2026-09-08", "2026-10-16", 30);

  it("1D = the whole newest ET session, extended hours included", () => {
    const out = sliceRange(fiveMin, { kind: "sessions", sessions: 1 });
    expect(sessions(out)).toEqual(["2026-10-16"]);
    expect(out).toHaveLength(16 * 12); // 04:00–20:00 of 5-min bars
  });

  it("5D = exactly the last 5 trading days, skipping the weekend", () => {
    const out = sliceRange(fiveMin, { kind: "sessions", sessions: 5 });
    expect(sessions(out)).toEqual([
      "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16",
    ]);
  });

  it("1M = one calendar month back from the newest bar", () => {
    const out = sliceRange(thirtyMin, { kind: "months", months: 1 });
    const days = sessions(out);
    expect(days[0]).toBe("2026-09-17"); // first weekday after 16 Sep
    expect(days[days.length - 1]).toBe("2026-10-16");
    expect(days.length).toBe(22);
  });

  it("1H = the newest 60 minutes", () => {
    const oneMin = extended("2026-10-16", "2026-10-16", 1);
    expect(sliceRange(oneMin, { kind: "minutes", minutes: 60 })).toHaveLength(60);
  });

  it("anchors at the newest bar, so a weekend still shows a full range", () => {
    // Data ends Friday; the span is measured from Friday, not from "now".
    const out = sliceRange(fiveMin, { kind: "sessions", sessions: 5 });
    expect(out[out.length - 1]).toBe(fiveMin[fiveMin.length - 1]);
  });

  it("returns everything when history is shorter than the span", () => {
    const short = extended("2026-10-15", "2026-10-16", 5);
    expect(sliceRange(short, { kind: "sessions", sessions: 5 })).toHaveLength(short.length);
    expect(sliceRange([], { kind: "months", months: 3 })).toEqual([]);
  });
});
