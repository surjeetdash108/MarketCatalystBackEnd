import { applyOfficialDayBar, sessionBoundsEt } from "./snapshot-cache.service";

describe("official day bar over FMP quotes (E2E Oct 2026, category J1)", () => {
  const q = { ticker: "ELMD", price: 26.37, open: 27.03, dayHigh: 27.03, dayLow: 26.29 } as unknown as Parameters<typeof applyOfficialDayBar>[0];
  it("takes Polygon's open at once, and its high/low only when final", () => {
    const mid = applyOfficialDayBar(q, { open: 26.72, high: 27.2, low: 26.28, final: false, fetchedAt: 0 });
    expect(mid).toMatchObject({ open: 26.72, dayHigh: 27.03, dayLow: 26.29 });
    const done = applyOfficialDayBar(q, { open: 26.72, high: 27.355, low: 26.28, final: true, fetchedAt: 0 });
    expect(done).toMatchObject({ open: 26.72, dayHigh: 27.355, dayLow: 26.28, price: 26.37 });
    expect(applyOfficialDayBar(q, undefined)).toBe(q);
  });
  it("reads the New York session clock across DST", () => {
    const fri = Date.parse("2026-10-23T18:00:00Z"); // 14:00 EDT
    expect(sessionBoundsEt(fri)).toEqual({ openedAt: Date.parse("2026-10-23T13:30:00Z"), closedAt: Date.parse("2026-10-23T20:00:00Z") });
    expect(sessionBoundsEt(Date.parse("2026-12-01T14:00:00Z")).openedAt).toBeNull(); // 09:00 EST, not open yet
    expect(sessionBoundsEt(Date.parse("2026-12-01T15:00:00Z")).openedAt).toBe(Date.parse("2026-12-01T14:30:00Z")); // EST open
    expect(sessionBoundsEt(Date.parse("2026-10-24T18:00:00Z"))).toEqual({ openedAt: null, closedAt: null }); // Saturday
  });
});
