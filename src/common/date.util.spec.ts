import { fmpEasternToUtcIso } from "./date.util";

describe("fmpEasternToUtcIso", () => {
  it("converts Eastern Daylight Time (EDT, UTC-4) strings accurately to UTC ISO", () => {
    // October is Daylight Saving Time in New York (-04:00)
    const result = fmpEasternToUtcIso("2026-10-12 14:33:47");
    expect(result).toBe("2026-10-12T18:33:47.000Z");
  });

  it("converts Eastern Standard Time (EST, UTC-5) strings accurately to UTC ISO", () => {
    // January is Standard Time in New York (-05:00)
    const result = fmpEasternToUtcIso("2026-01-15 14:33:47");
    expect(result).toBe("2026-01-15T19:33:47.000Z");
  });

  it("preserves strings that already have UTC indicator Z or offset", () => {
    const iso = "2026-10-12T18:33:47.000Z";
    expect(fmpEasternToUtcIso(iso)).toBe(iso);

    const withOffset = "2026-10-12T14:33:47-04:00";
    expect(fmpEasternToUtcIso(withOffset)).toBe("2026-10-12T18:33:47.000Z");
  });

  it("handles date-only strings gracefully", () => {
    const result = fmpEasternToUtcIso("2026-10-12");
    // Midnight Eastern Time (00:00:00 EDT) is 04:00:00 UTC
    expect(result).toBe("2026-10-12T04:00:00.000Z");
  });

  it("falls back to current time on empty or invalid inputs", () => {
    const now = Date.now();
    const res = fmpEasternToUtcIso("");
    const parsed = new Date(res).getTime();
    expect(Math.abs(parsed - now)).toBeLessThan(5000);
  });
});
