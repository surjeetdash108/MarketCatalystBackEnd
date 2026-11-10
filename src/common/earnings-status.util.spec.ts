import { formatEarningsDateStatus } from "./earnings-status.util";

describe("earnings-status.util", () => {
  it("formats unconfirmed future earnings date with '(Estimated)' label", () => {
    // e.g. NVDA Nov 18 unconfirmed projected date
    const res = formatEarningsDateStatus({
      date: "2026-11-18",
      confirmed: false,
    });

    expect(res.isEstimated).toBe(true);
    expect(res.statusLabel).toBe("Estimated");
    expect(res.displayText).toBe("Nov 18, 2026 (Estimated)");
  });

  it("formats confirmed earnings date cleanly without 'Estimated' label", () => {
    const res = formatEarningsDateStatus({
      date: "2026-11-18",
      confirmed: true,
    });

    expect(res.isEstimated).toBe(false);
    expect(res.statusLabel).toBe("Confirmed");
    expect(res.displayText).toBe("Nov 18, 2026");
  });

  it("returns null displayText when date is null or invalid", () => {
    const res = formatEarningsDateStatus({
      date: null,
    });

    expect(res.displayText).toBeNull();
    expect(res.isEstimated).toBe(false);
  });
});
