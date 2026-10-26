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
