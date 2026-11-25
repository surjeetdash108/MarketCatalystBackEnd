import { splitAction } from "./corporate-actions.job";

describe("splitAction: when a split forces a re-backfill", () => {
  it("a first-seen split from last week re-backfills (SNDK, 20 Nov 2026)", () => {
    expect(splitAction("2026-11-20", null, "2026-11-26")).toBe("reset");
  });
  it("a first-seen old split is only a baseline (history already adjusted)", () => {
    expect(splitAction("2024-06-10", null, "2026-11-26")).toBe("baseline");
  });
  it("a newer split than the one recorded re-backfills; the same one does nothing", () => {
    expect(splitAction("2026-11-20", "2025-01-02", "2026-11-26")).toBe("reset");
    expect(splitAction("2026-11-20", "2026-11-20", "2026-11-26")).toBe("none");
  });
});
