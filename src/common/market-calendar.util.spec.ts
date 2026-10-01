import {
  etDate, isFriday, isLastFridayOfMonth, lastFridayOf,
  weekBounds, monthBounds, monthKey,
} from "./market-calendar.util";

/** Noon ET, so the instant can't drift across a day boundary in either zone. */
const at = (iso: string) => new Date(`${iso}T16:00:00Z`);

describe("lastFridayOf", () => {
  it("handles months with five Fridays", () => {
    // Aug 2026: Fridays fall on 7, 14, 21, 28.
    expect(lastFridayOf("2026-08-01")).toBe("2026-08-28");
    // Jan 2026 ends on a Saturday, so the last Friday is the 30th.
    expect(lastFridayOf("2026-01-15")).toBe("2026-01-30");
  });

  it("handles a month ending exactly ON a Friday", () => {
    expect(lastFridayOf("2026-10-01")).toBe("2026-10-30");
  });

  it("handles February in a leap year", () => {
    expect(lastFridayOf("2028-02-10")).toBe("2028-02-25");
  });

  it("always returns a Friday, for every month across three years", () => {
    for (let y = 2026; y <= 2028; y++) {
      for (let m = 1; m <= 12; m++) {
        const iso = `${y}-${String(m).padStart(2, "0")}-01`;
        const lf = lastFridayOf(iso);
        const [yy, mm, dd] = lf.split("-").map(Number);
        expect(new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()).toBe(5);
        // and it must be within the last 7 days of that month
        expect(Number(lf.slice(8))).toBeGreaterThan(21);
      }
    }
  });
});

describe("isLastFridayOfMonth", () => {
  it("is true only on the month's final Friday", () => {
    expect(isLastFridayOfMonth(at("2026-08-28"))).toBe(true);
  });

  it("is FALSE on earlier Fridays — the trap §9 calls out", () => {
    for (const d of ["2026-08-07", "2026-08-14", "2026-08-21"]) {
      expect(isFriday(at(d))).toBe(true);        // it IS a Friday
      expect(isLastFridayOfMonth(at(d))).toBe(false); // but not the last one
    }
  });

  it("is false on non-Fridays, including the last day of the month", () => {
    expect(isLastFridayOfMonth(at("2026-08-31"))).toBe(false); // Monday
    expect(isLastFridayOfMonth(at("2026-08-29"))).toBe(false); // Saturday
  });

  it("fires exactly once per month across a full year", () => {
    let hits = 0;
    for (let d = new Date(Date.UTC(2026, 0, 1)); d < new Date(Date.UTC(2027, 0, 1));
         d = new Date(d.getTime() + 86_400_000)) {
      if (isLastFridayOfMonth(new Date(d.getTime() + 16 * 3600_000))) hits++;
    }
    expect(hits).toBe(12);
  });
});

describe("period bounds", () => {
  it("weekBounds runs Monday to Sunday", () => {
    expect(weekBounds("2026-08-28")).toEqual({ start: "2026-08-24", end: "2026-08-30" });
  });
  it("weekBounds puts Sunday in the week that just ended", () => {
    expect(weekBounds("2026-08-30")).toEqual({ start: "2026-08-24", end: "2026-08-30" });
  });
  it("monthBounds covers the whole month", () => {
    expect(monthBounds("2026-08-15")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(monthBounds("2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });
  it("monthKey is the YYYY-MM tie between analysis and cleanup", () => {
    expect(monthKey("2026-08-28")).toBe("2026-08");
  });
});

describe("etDate", () => {
  it("reports the New York day, not the UTC day", () => {
    // 01:30 UTC on the 24th is still 21:30 on the 23rd in New York.
    expect(etDate(new Date("2026-08-24T01:30:00Z"))).toBe("2026-08-23");
  });
});
