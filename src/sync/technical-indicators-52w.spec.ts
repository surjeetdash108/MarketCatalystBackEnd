import * as fs from "fs";
import * as path from "path";
import { computeIndicators, fiftyTwoWeekWindow } from "./technical-indicators.job";

/**
 * Fixtures: real Polygon daily bars (2025-10-22 … 2026-10-23) for SFM, GS, CAT.
 * Expected values are the public 52-week high/low recorded by the Oct 24 E2E
 * run (Friday Oct 23 close). They come from a 52-WEEK window — sessions dated
 * after Oct 23 2026 − 364 days (= Fri Oct 24 2025), i.e. Mon Oct 27 2025 on:
 * SFM's 107.31 is the Oct 28 high, CAT's 521.43 the Oct 27 low, GS's 754 the
 * Nov 21 low. A 252-session window (or one starting the day after the same
 * date a year back) still reaches Oct 23/24 2025 and gives 109.61 / 513.01 /
 * 744.66 — the values the test flagged.
 */
describe("52-week high/low — 52-week (364-day) window of completed sessions", () => {
  const fixtures = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures/52w-fixtures.json"), "utf-8"),
  );
  const AFTER_CLOSE_OCT23 = new Date("2026-10-24T15:00:00Z"); // Saturday, as the test ran

  it("window starts after (last session − 364 days)", () => {
    const w = fiftyTwoWeekWindow(fixtures.SFM);
    expect(w[0].barDate).toBe("2025-10-27");
    expect(w[w.length - 1].barDate).toBe("2026-10-23");
  });

  it.each([
    ["SFM", "high52", 107.31],
    ["GS", "low52", 754],
    ["CAT", "low52", 521.43],
  ])("%s %s matches the public value", (t, field, expected) => {
    const ind = computeIndicators(fixtures[t as string], new Map(), AFTER_CLOSE_OCT23)!;
    expect(ind).not.toBeNull();
    expect((ind as Record<string, unknown>)[field as string]).toBe(expected);
  });

  it("never includes an in-progress session (midday spike bar for today)", () => {
    const today = new Date().toISOString().slice(0, 10);
    const bars = [
      ...fixtures.SFM,
      { barDate: today, open: 68, high: 120, low: 67, close: 68.5, volume: 1000, vwap: 68.2 },
    ];
    const midday = new Date(`${today}T16:00:00Z`); // 12:00 ET (EDT) — session open
    const ind = computeIndicators(bars, new Map(), midday)!;
    expect(ind.high52).not.toBe(120);
  });
});

describe("52-week range during the session the vendor has not rolled over yet", () => {
  // Real Polygon bars to Mon Oct 26 2026. Public (Yahoo), read Oct 26 15:45–18:00 ET:
  // ANIP 96.57, MSEX 62.18, ORCL 287 — the 52 weeks ending at the PREVIOUS
  // session (Fri Oct 23, so from Mon Oct 27 2025) plus today's high/low. The
  // window rolls to the new session only once its day, extended hours
  // included, is over (20:00 ET) — the Oct 23 reads above came after it.
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/52w-rollover-oct26.json"), "utf-8"));
  const AFTER_CLOSE_OCT26 = new Date("2026-10-26T21:00:00Z"); // 17:00 ET

  it.each([
    ["ANIP", "high52", 96.57],
    ["MSEX", "high52", 62.18],
    ["ORCL", "high52", 287],
  ])("%s %s matches the public value read on Oct 26 after the close", (t, field, expected) => {
    // As the live API runs it after 16:00: with Polygon's official Oct 26 day bar.
    const bars = fx[t as string];
    const last = bars[bars.length - 1];
    const official = new Map([[last.barDate, { high: last.high, low: last.low, close: last.close }]]);
    const ind = computeIndicators(bars, new Map(), AFTER_CLOSE_OCT26, undefined, official)!;
    expect(Math.abs((ind as unknown as Record<string, number>)[field as string] - (expected as number))).toBeLessThanOrEqual((expected as number) * 0.005);
  });

  it("after 20:00 ET the window rolls to the new session", () => {
    const w = fiftyTwoWeekWindow(fx.ANIP, new Date("2026-10-27T01:00:00Z")); // 21:00 ET Oct 26
    expect(w[0].barDate).toBe("2025-10-28");
  });
});
