import { MAX_BARS_PER_DOC, trimBarsToRange } from "./ondemand.service";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 13, 20);

describe("trimBarsToRange (stock_bars stays under Firestore's 1 MB)", () => {
  it("drops bars older than the doc's window (+1 day slack)", () => {
    const bars = [30, 10, 6.5, 5.5, 1, 0].map((d) => ({ t: now - d * DAY }));
    expect(trimBarsToRange(bars, 5, now).map((b) => (now - b.t) / DAY)).toEqual([5.5, 1, 0]);
  });

  it("never keeps more than MAX_BARS_PER_DOC (the newest win)", () => {
    const bars = Array.from({ length: MAX_BARS_PER_DOC + 500 }, (_, i) => ({ t: now - (MAX_BARS_PER_DOC + 500 - i) * 60_000 }));
    const kept = trimBarsToRange(bars, Infinity, now);
    expect(kept).toHaveLength(MAX_BARS_PER_DOC);
    expect(kept[kept.length - 1]).toBe(bars[bars.length - 1]);
    // ~80 bytes per bar in Firestore → comfortably under 1 MiB.
    expect(MAX_BARS_PER_DOC * 80).toBeLessThan(900_000);
  });
});
