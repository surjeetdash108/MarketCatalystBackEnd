import {
  chronological,
  Lot,
  OversellError,
  summarizeLots,
  TxnType,
  withRunningTotals,
} from "./portfolio-lots";

const txn = (
  id: string,
  type: TxnType,
  shares: number,
  price: number | null,
  date: string,
  createdAt = `${date}T12:00:00.000Z`,
): Lot => ({ id, type, shares, price, date, createdAt });
const buy = (id: string, s: number, p: number | null, d: string, c?: string) =>
  txn(id, "buy", s, p, d, c);
const sell = (id: string, s: number, p: number | null, d: string, c?: string) =>
  txn(id, "sell", s, p, d, c);

describe("portfolio transactions", () => {
  describe("buys only", () => {
    // Buy 10 @ $100, a week later 5 @ $90, ten days after that 8 @ $110.
    const lots = [
      buy("c", 8, 110, "2026-09-18"),
      buy("a", 10, 100, "2026-09-01"),
      buy("b", 5, 90, "2026-09-08"),
    ];

    it("computes the share-weighted average cost", () => {
      const s = summarizeLots(lots);
      expect(s.shares).toBe(23);
      expect(s.totalCost).toBe(2330); // 1000 + 450 + 880
      expect(s.avgCost).toBeCloseTo(101.3043478, 6);
      expect(s.realizedPL).toBe(0);
      expect(s.buyCount).toBe(3);
      expect(s.sellCount).toBe(0);
      expect(s.firstDate).toBe("2026-09-01");
      expect(s.lastDate).toBe("2026-09-18");
    });

    it("returns newest first with the running position after each buy", () => {
      const rows = withRunningTotals(lots);
      expect(rows.map((r) => r.id)).toEqual(["c", "b", "a"]);
      expect(rows[2]).toMatchObject({
        sharesAfter: 10,
        avgCostAfter: 100,
        amount: 1000,
        realizedPL: null,
      });
      expect(rows[1]).toMatchObject({
        sharesAfter: 15,
        avgCostAfter: 96.66666667,
        amount: 450,
      });
      expect(rows[0].sharesAfter).toBe(23);
    });
  });

  describe("sells", () => {
    it("reduces shares, keeps the average and books realized P/L", () => {
      const lots = [
        buy("a", 10, 100, "2026-09-01"),
        buy("b", 10, 120, "2026-09-05"), // average 110
        sell("c", 5, 130, "2026-09-10"), // +5 × 20
      ];
      const s = summarizeLots(lots);
      expect(s.shares).toBe(15);
      expect(s.avgCost).toBe(110);
      expect(s.totalCost).toBe(1650);
      expect(s.realizedPL).toBe(100);
      expect(s.sellCount).toBe(1);

      const [saleRow] = withRunningTotals(lots);
      expect(saleRow).toMatchObject({
        id: "c",
        type: "sell",
        amount: 650,
        realizedPL: 100,
        sharesAfter: 15,
        avgCostAfter: 110,
      });
    });

    it("books a realized loss when selling below the average", () => {
      const s = summarizeLots([
        buy("a", 4, 50, "2026-09-01"),
        sell("b", 4, 45, "2026-09-02"),
      ]);
      expect(s.realizedPL).toBe(-20);
    });

    it("closes the position at zero and restarts the average on the next buy", () => {
      const lots = [
        buy("a", 10, 50, "2026-09-01"),
        sell("b", 10, 60, "2026-09-02"), // closes, +100
        buy("c", 5, 80, "2026-09-03"),
      ];
      const closed = summarizeLots(lots.slice(0, 2));
      expect(closed.shares).toBe(0);
      expect(closed.avgCost).toBeNull();
      expect(closed.totalCost).toBeNull();
      expect(closed.realizedPL).toBe(100);

      const s = summarizeLots(lots);
      expect(s.shares).toBe(5);
      expect(s.avgCost).toBe(80); // not blended with the closed position
      expect(s.realizedPL).toBe(100);
      expect(withRunningTotals(lots)[1]).toMatchObject({
        sharesAfter: 0,
        avgCostAfter: null,
      });
    });

    it("rejects selling more than is held", () => {
      const lots = [
        buy("a", 5, 10, "2026-09-10"),
        sell("b", 6, 12, "2026-09-12"),
      ];
      expect(() => summarizeLots(lots)).toThrow(OversellError);
      try {
        summarizeLots(lots);
      } catch (e) {
        expect(e).toMatchObject({ date: "2026-09-12", held: 5, attempted: 6 });
      }
    });

    it("rejects a back-dated sale before the shares were bought", () => {
      const lots = [
        buy("a", 10, 10, "2026-09-10"),
        sell("b", 3, 12, "2026-09-05"),
      ];
      let caught: unknown;
      try {
        summarizeLots(lots);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(OversellError);
      expect(caught).toMatchObject({
        date: "2026-09-05",
        held: 0,
        attempted: 3,
      });
    });

    it("closes exactly when selling fractional shares", () => {
      const s = summarizeLots([
        buy("a", 0.1, 10, "2026-09-01"),
        buy("b", 0.2, 10, "2026-09-02"),
        sell("c", 0.3, 11, "2026-09-03"),
      ]);
      expect(s.shares).toBe(0);
      expect(s.realizedPL).toBe(0.3);
    });
  });

  describe("deleting a transaction (replaying what remains)", () => {
    const lots = [
      buy("a", 10, 60, "2026-06-01"),
      buy("b", 5, 70, "2026-07-01"),
      sell("c", 12, 80, "2026-08-01"),
    ];
    const without = (id: string) => lots.filter((l) => l.id !== id);

    it("recomputes the position when a buy is removed and the rest is valid", () => {
      // Without the sale: 15 shares at (600 + 350) / 15.
      const s = summarizeLots(without("c"));
      expect(s.shares).toBe(15);
      expect(s.avgCost).toBeCloseTo(63.3333333, 6);
      expect(s.realizedPL).toBe(0);
    });

    it("refuses removing a buy that a later sale depended on", () => {
      // Without buy "a", the 12-share sale exceeds the 5 shares then held.
      let caught: unknown;
      try {
        summarizeLots(without("a"));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(OversellError);
      expect(caught).toMatchObject({
        date: "2026-08-01",
        held: 5,
        attempted: 12,
      });
    });
  });

  it("orders same-day transactions by when they were recorded", () => {
    const sameDay = [
      buy("late", 1, 10, "2026-09-01", "2026-09-01T15:00:00.000Z"),
      buy("early", 1, 20, "2026-09-01", "2026-09-01T09:00:00.000Z"),
    ];
    expect(chronological(sameDay).map((l) => l.id)).toEqual(["early", "late"]);
  });

  it("averages over priced shares only and flags a partial cost", () => {
    const s = summarizeLots([
      { ...buy("open", 10, null, "2026-08-01"), opening: true },
      buy("b", 5, 50, "2026-09-01"),
    ]);
    expect(s.shares).toBe(15);
    expect(s.avgCost).toBe(50);
    expect(s.partialCost).toBe(true);
  });

  it("has no average when nothing is priced", () => {
    const s = summarizeLots([buy("x", 3, null, "2026-09-01")]);
    expect(s.avgCost).toBeNull();
    expect(s.totalCost).toBeNull();
  });
});
