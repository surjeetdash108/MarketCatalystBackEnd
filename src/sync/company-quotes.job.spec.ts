import { sessionFraction } from "./company-quotes.job";

describe("sessionFraction (live RVOL weighting)", () => {
  it("is null before the open and on weekends", () => {
    expect(sessionFraction(Date.parse("2026-10-22T13:00:00Z"))).toBeNull(); // 9:00 ET
    expect(sessionFraction(Date.parse("2026-10-24T16:00:00Z"))).toBeNull(); // Saturday
  });
  it("scales through the session and caps at 1 after the close", () => {
    expect(sessionFraction(Date.parse("2026-10-22T13:39:00Z"))).toBeCloseTo(0.05); // 9:39 ET floor
    expect(sessionFraction(Date.parse("2026-10-22T16:45:00Z"))).toBeCloseTo(0.5); // 12:45 ET
    expect(sessionFraction(Date.parse("2026-10-22T21:30:00Z"))).toBe(1); // 17:30 ET
  });
});
