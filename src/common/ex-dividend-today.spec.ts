import { ExDividendToday, dividendCalendarPath } from "./ex-dividend-today";

const NOON_NOV24 = Date.parse("2026-11-24T17:00:00Z"); // 12:00 ET

describe("ExDividendToday", () => {
  it("keeps only today's rows, sums two events, and maps BRK-B to BRK.B", async () => {
    const load = jest.fn().mockResolvedValue([
      { symbol: "COST", date: "2026-11-24", dividend: 30 },
      { symbol: "COST", date: "2026-11-24", dividend: 1.47 },
      { symbol: "BRK-B", date: "2026-11-24", dividend: 0.5 },
      { symbol: "JNJ", date: "2026-11-25", dividend: 1.34 }, // tomorrow
      { symbol: "ZERO", date: "2026-11-24", dividend: 0 },
      { symbol: "BAD", date: "2026-11-24", dividend: "x" },
    ]);
    const m = await new ExDividendToday(load).get(NOON_NOV24);
    expect(m.get("COST")).toBeCloseTo(31.47, 6);
    expect(m.get("BRK.B")).toBe(0.5);
    expect(m.has("JNJ")).toBe(false);
    expect(m.has("ZERO")).toBe(false);
    expect(m.has("BAD")).toBe(false);
    expect(load).toHaveBeenCalledWith("2026-11-24");
  });

  it("asks once per Eastern day", async () => {
    const load = jest
      .fn()
      .mockResolvedValue([
        { symbol: "COST", date: "2026-11-24", dividend: 30 },
      ]);
    const c = new ExDividendToday(load);
    await c.get(NOON_NOV24);
    await c.get(NOON_NOV24 + 3600_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a failed or empty load gives an empty map, retried after ten minutes, then recovers", async () => {
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce([
        { symbol: "COST", date: "2026-11-24", dividend: 30 },
      ]);
    const c = new ExDividendToday(load);
    expect((await c.get(NOON_NOV24)).size).toBe(0);
    expect((await c.get(NOON_NOV24 + 60_000)).size).toBe(0); // inside the retry window: no new call
    expect(load).toHaveBeenCalledTimes(1);
    expect((await c.get(NOON_NOV24 + 11 * 60_000)).get("COST")).toBe(30);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("builds the calendar request for one day", () => {
    expect(dividendCalendarPath("2026-11-24")).toBe(
      "dividends-calendar?from=2026-11-24&to=2026-11-24",
    );
  });
});
