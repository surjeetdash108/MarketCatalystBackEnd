import {
  forwardAnnualDividend,
  resolveDividendYields,
  DivHistItem,
} from "./dividend-annualization.util";

describe("dividend-annualization.util", () => {
  const nowMs = Date.parse("2026-10-24T12:00:00Z");

  describe("forwardAnnualDividend with grace window", () => {
    it("returns null for suspended dividend with pre-2020 payments (BA / PLAY scenario)", () => {
      // BA suspended in early 2020: quarterly payment of $2.055
      const baHistory: DivHistItem[] = [
        {
          exDividendDate: "2020-02-13",
          cashAmount: 2.055,
          dividendType: "CD",
          frequency: 4,
        },
        {
          exDividendDate: "2019-11-07",
          cashAmount: 2.055,
          dividendType: "CD",
          frequency: 4,
        },
      ];
      const res = forwardAnnualDividend(baHistory, nowMs);
      expect(res).toBeNull();
    });

    it("returns null for PLAY pre-2020 payments with amount property", () => {
      // PLAY suspended in 2020: quarterly payment of $0.16
      const playHistory: DivHistItem[] = [
        {
          exDividendDate: "2020-01-15",
          amount: 0.16,
          dividendType: "CD",
          frequency: 4,
        },
      ];
      const res = forwardAnnualDividend(playHistory, nowMs);
      expect(res).toBeNull();
    });

    it("returns forward annual dividend for active payer within grace window", () => {
      // Active quarterly payer paid 30 days ago
      const recentDate = new Date(nowMs - 30 * 86_400_000).toISOString().slice(0, 10);
      const activeHistory: DivHistItem[] = [
        {
          exDividendDate: recentDate,
          cashAmount: 1.25,
          dividendType: "CD",
          frequency: 4,
        },
      ];
      const res = forwardAnnualDividend(activeHistory, nowMs);
      expect(res).toEqual({
        perShare: 5.0,
        paymentsPerYear: 4,
      });
    });
  });

  describe("resolveDividendYields - unified yield resolver", () => {
    it("differentiates forward vs trailing yields for JPM with recent hike", () => {
      // JPM scenario: raised dividend recently from 1.15 to 1.25
      // 3 past payments of 1.15 and latest payment of 1.25 -> trailing sum = 4.70
      // Forward run-rate = 1.25 * 4 = 5.00
      // Stock price = 251.26
      // Forward yield = 5.00 / 251.26 = 1.99%
      // Trailing yield = 4.70 / 251.26 = 1.87% (or 1.85%)
      const price = 251.26;
      const d1 = new Date(nowMs - 20 * 86_400_000).toISOString().slice(0, 10);
      const d2 = new Date(nowMs - 110 * 86_400_000).toISOString().slice(0, 10);
      const d3 = new Date(nowMs - 200 * 86_400_000).toISOString().slice(0, 10);
      const d4 = new Date(nowMs - 290 * 86_400_000).toISOString().slice(0, 10);

      const jpmHistory: DivHistItem[] = [
        { exDividendDate: d1, cashAmount: 1.25, dividendType: "CD", frequency: 4 },
        { exDividendDate: d2, cashAmount: 1.15, dividendType: "CD", frequency: 4 },
        { exDividendDate: d3, cashAmount: 1.15, dividendType: "CD", frequency: 4 },
        { exDividendDate: d4, cashAmount: 1.15, dividendType: "CD", frequency: 4 },
      ];

      const res = resolveDividendYields({ history: jpmHistory, price, nowMs });
      expect(res.isPayer).toBe(true);
      expect(res.forward).not.toBeNull();
      expect(res.trailing).not.toBeNull();
      expect(res.forward?.yieldPct).toBe(1.99);
      expect(res.forward?.perShare).toBe(5.0);
      expect(res.trailing?.yieldPct).toBe(1.87);
      expect(res.trailing?.perShare).toBe(4.7);
    });

    it("returns isPayer: false and forward: null for pre-2020 suspended payer", () => {
      const baHistory: DivHistItem[] = [
        { exDividendDate: "2020-02-13", cashAmount: 2.055, dividendType: "CD", frequency: 4 },
      ];
      const res = resolveDividendYields({ history: baHistory, price: 180.0, nowMs });
      expect(res.isPayer).toBe(false);
      expect(res.forward).toBeNull();
      expect(res.trailing).toBeNull();
    });
  });
});
