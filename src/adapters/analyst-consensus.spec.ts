import { activeCoverage, ratingBucket } from "./analyst-ratings.adapter";

describe("consensus from active coverage", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");

  it("maps firm rating wording to the five buckets", () => {
    expect(ratingBucket("Overweight")).toBe("buy");
    expect(ratingBucket("Market Outperform")).toBe("buy");
    expect(ratingBucket("Sector Underperform")).toBe("sell");
    expect(ratingBucket("Equal-Weight")).toBe("hold");
    expect(ratingBucket("Peer Perform")).toBe("hold");
    expect(ratingBucket("Strong Buy")).toBe("strongBuy");
    expect(ratingBucket("")).toBeNull();
  });

  it("counts each firm once, by its latest rating, within the coverage window", () => {
    const rows = [
      { date: "2026-10-01", gradingCompany: "JP Morgan", newGrade: "Overweight" },
      { date: "2026-03-01", gradingCompany: "JPMorgan Chase", newGrade: "Neutral" }, // same firm, older
      { date: "2026-09-01", gradingCompany: "Wells Fargo", newGrade: "Equal-Weight" },
      { date: "2026-08-01", gradingCompany: "UBS", newGrade: "Sell" },
      { date: "2022-01-01", gradingCompany: "Old Firm", newGrade: "Buy" }, // stopped covering
    ];
    expect(activeCoverage(rows, now)).toEqual({ strongBuy: 0, buy: 1, hold: 1, sell: 1, strongSell: 0, consensus: "Hold" });
  });

  it("returns null with fewer than three active firms", () => {
    expect(activeCoverage([{ date: "2026-10-01", gradingCompany: "UBS", newGrade: "Buy" }], now)).toBeNull();
  });
});
