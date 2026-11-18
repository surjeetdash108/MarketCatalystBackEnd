import { computeRsScore, computeRsScoreDated, rsEligibleType, rsHistoryConsistent } from "./rs-rating.job";

const DAY = 86_400_000;
/** Weekday-ish dated closes from `days` ago to today with a price function. */
function dated(days: number, price: (i: number) => number, today = "2026-11-18") {
  const end = Date.parse(`${today}T00:00:00Z`);
  const out: Array<{ date: string; close: number }> = [];
  for (let d = days; d >= 0; d--) {
    const t = end - d * DAY;
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    out.push({ date: new Date(t).toISOString().slice(0, 10), close: price(days - d) });
  }
  return out;
}

describe("RS rating inputs", () => {
  it("history with a reverse split or a reused symbol (one-day jump over 4x) is not scored", () => {
    // BNY May 21: $10.20 → $138.98 (symbol reused); LOBO: 10-for-1 reverse split.
    expect(rsHistoryConsistent([10, 10.1, 10.2, 138.98, 139])).toBe(false);
    expect(rsHistoryConsistent([0.38, 0.35, 3.51, 3.15])).toBe(false);
  });
  it("a bad-data dip that snaps back within days is not scored (TJGC 6.57 → 2.19 → 6.11)", () => {
    expect(rsHistoryConsistent([6.5, 6.57, 2.19, 2.2, 6.11, 6.2])).toBe(false);
  });
  it("placeholder closes that snap back after six sessions are caught too (TJGC as stored)", () => {
    expect(rsHistoryConsistent([6.45, 6.57, 6.57, 6.57, 6.57, 6.57, 2.19, 2.19, 2.19, 2.19, 2.19, 2.19, 6.11, 6.68])).toBe(false);
  });
  it("a big real move that sticks is kept (MRNA-style +177% day)", () => {
    expect(rsHistoryConsistent([62, 62.96, 174.38, 170, 172, 168, 171, 169])).toBe(true);
  });

  it("dated quarters: gaps don't stretch the window (91-day quarters by calendar)", () => {
    // Price doubles over the last 91 days, flat before; a month-long gap that covers no quarter anchor.
    const full = dated(366, (i) => (i < 275 ? 100 : 100 + ((i - 275) / 91) * 100));
    const gappy = full.filter((b) => b.date < "2026-06-01" || b.date > "2026-06-30");
    const a = computeRsScoreDated(full, "2026-11-18");
    const b = computeRsScoreDated(gappy, "2026-11-18");
    expect(a).not.toBeNull();
    expect(Math.abs((a as number) - (b as number))).toBeLessThan(0.01);
  });
  it("history older than a year doesn't count (MF: 260 bars spanning 2023–2026)", () => {
    const old = dated(1200, (i) => (i < 700 ? 1 : 4)).filter((_, i) => i % 3 === 0);
    // the jump happened ~500 days ago: inside the year it is flat at 4
    expect(computeRsScoreDated(old, "2026-11-18")).toBeCloseTo(0, 5);
  });
  it("needs at least two quarters of history", () => {
    expect(computeRsScoreDated(dated(100, () => 10), "2026-11-18")).toBeNull();
    expect(computeRsScore(Array.from({ length: 100 }, () => 10))).toBeNull();
    expect(computeRsScore(Array.from({ length: 130 }, () => 10))).toBe(0);
  });
  it("common stock and ADRs only; unknown type passes", () => {
    expect(rsEligibleType("CS")).toBe(true);
    expect(rsEligibleType("ADRC")).toBe(true);
    expect(rsEligibleType(undefined)).toBe(true);
    for (const t of ["ETF", "ETV", "ETS", "ETN", "PFD", "FUND", "UNIT", "WARRANT", "RIGHT"]) expect(rsEligibleType(t)).toBe(false);
  });
});
