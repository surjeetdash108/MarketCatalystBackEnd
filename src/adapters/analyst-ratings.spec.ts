import { selectGrades, normaliseGradeAction } from "./analyst-ratings.adapter";

const row = (date: string, action: string) => ({ date, action });

describe("selectGrades", () => {
  it("keeps an initiation that sits behind a wall of maintains", () => {
    // The real prod failure: 8-row truncation meant the Initiations tab
    // matched zero rows across 460 tickers.
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => row(`2026-08-${30 - i}`, "maintain")),
      row("2026-05-01", "initialise"),
    ];
    const out = selectGrades(rows);
    expect(out.some(r => /init/i.test(r.action))).toBe(true);
  });

  it("caps the total rows kept", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`2026-01-${(i % 28) + 1}`, "maintain"));
    expect(selectGrades(rows).length).toBeLessThanOrEqual(20);
  });

  it("keeps upgrades and downgrades ahead of maintains", () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => row(`2026-08-${25 - i}`, "maintain")),
      row("2026-02-10", "upgrade"),
      row("2026-01-10", "downgrade"),
    ];
    const out = selectGrades(rows);
    expect(out.some(r => r.action === "upgrade")).toBe(true);
    expect(out.some(r => r.action === "downgrade")).toBe(true);
  });

  it("returns newest-first", () => {
    const out = selectGrades([row("2026-01-01", "upgrade"), row("2026-06-01", "maintain")]);
    expect(out[0].date).toBe("2026-06-01");
  });

  it("treats an unknown future action as an event, not a maintain", () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => row(`2026-08-${25 - i}`, "maintain")),
      row("2026-01-05", "resume coverage"),
    ];
    expect(selectGrades(rows).some(r => r.action === "resume coverage")).toBe(true);
  });

  it("handles empty input and null actions", () => {
    expect(selectGrades([])).toEqual([]);
    const out = selectGrades([{ date: "2026-01-01", action: null }]);
    expect(out).toHaveLength(1);
  });
});

describe("normaliseGradeAction", () => {
  it("labels an empty previousGrade with a real newGrade as an initiation", () => {
    // Real row: META / Exane BNP Paribas, "" -> "Outperform", action "".
    expect(normaliseGradeAction("", null, "Outperform")).toBe("initiate");
    expect(normaliseGradeAction("", "", "Outperform")).toBe("initiate");
  });
  it("leaves genuine actions untouched", () => {
    expect(normaliseGradeAction("upgrade", "Hold", "Buy")).toBe("upgrade");
    expect(normaliseGradeAction("maintain", "Buy", "Buy")).toBe("maintain");
  });
  it("does not invent an initiation when a previous grade exists", () => {
    expect(normaliseGradeAction("", "Hold", "Buy")).toBeNull();
  });
  it("nulls a blank action rather than storing an empty string", () => {
    expect(normaliseGradeAction("", "Hold", "")).toBeNull();
  });
});
