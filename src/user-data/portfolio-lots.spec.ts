import {
  chronological,
  Lot,
  summarizeLots,
  withRunningTotals,
} from "./portfolio-lots";

const lot = (
  id: string,
  shares: number,
  price: number | null,
  date: string,
  createdAt = `${date}T12:00:00.000Z`,
): Lot => ({ id, shares, price, date, createdAt });

describe("portfolio lots", () => {
  // Buy 10 @ $100, a week later 5 @ $90, ten days after that 8 @ $110.
  const lots = [
    lot("c", 8, 110, "2026-09-18"),
    lot("a", 10, 100, "2026-09-01"),
    lot("b", 5, 90, "2026-09-08"),
  ];

  it("computes the share-weighted average cost", () => {
    const s = summarizeLots(lots);
    expect(s.shares).toBe(23);
    // (10*100 + 5*90 + 8*110) / 23 = 2330 / 23
    expect(s.totalCost).toBe(2330);
    expect(s.avgCost).toBeCloseTo(101.3043478, 6);
    expect(s.partialCost).toBe(false);
    expect(s.firstDate).toBe("2026-09-01");
    expect(s.lastDate).toBe("2026-09-18");
    expect(s.lotCount).toBe(3);
  });

  it("returns lots newest first with the running average after each buy", () => {
    const rows = withRunningTotals(lots);
    expect(rows.map((r) => r.id)).toEqual(["c", "b", "a"]);

    const [third, second, first] = rows;
    expect(first.sharesAfter).toBe(10);
    expect(first.avgCostAfter).toBe(100);
    expect(first.amount).toBe(1000);

    expect(second.sharesAfter).toBe(15);
    expect(second.avgCostAfter).toBe(96.66666667); // 1450 / 15, rounded to 8dp
    expect(second.amount).toBe(450);

    expect(third.sharesAfter).toBe(23);
    expect(third.avgCostAfter).toBeCloseTo(101.3043478, 6);
    expect(third.amount).toBe(880);
  });

  it("orders same-day buys by when they were recorded", () => {
    const sameDay = [
      lot("late", 1, 10, "2026-09-01", "2026-09-01T15:00:00.000Z"),
      lot("early", 1, 20, "2026-09-01", "2026-09-01T09:00:00.000Z"),
    ];
    expect(chronological(sameDay).map((l) => l.id)).toEqual(["early", "late"]);
  });

  it("averages over priced lots only and flags a partial cost", () => {
    const s = summarizeLots([
      { ...lot("open", 10, null, "2026-08-01"), opening: true },
      lot("buy", 5, 50, "2026-09-01"),
    ]);
    expect(s.shares).toBe(15);
    expect(s.avgCost).toBe(50);
    expect(s.totalCost).toBe(250);
    expect(s.partialCost).toBe(true);
  });

  it("has no average when nothing is priced", () => {
    const s = summarizeLots([lot("x", 3, null, "2026-09-01")]);
    expect(s.avgCost).toBeNull();
    expect(s.totalCost).toBeNull();
  });

  it("removes float noise from fractional shares", () => {
    const s = summarizeLots([
      lot("a", 0.1, 10, "2026-09-01"),
      lot("b", 0.2, 10, "2026-09-02"),
    ]);
    expect(s.shares).toBe(0.3);
    expect(s.totalCost).toBe(3);
  });
});
