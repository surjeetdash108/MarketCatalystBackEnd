import { aggregateSectors } from "./sectors.job";

const B = 1e9;

describe("aggregateSectors", () => {
  it("is the cap-weighted move of the stocks, with funds out and each company once", () => {
    const agg = aggregateSectors([
      {
        ticker: "GOOGL",
        name: "Alphabet Inc.",
        type: "CS",
        sector: "Technology Services",
        marketCap: 100 * B,
        pctChange: -2,
      },
      {
        ticker: "GOOG",
        name: "Alphabet Inc.",
        type: "CS",
        sector: "Technology Services",
        marketCap: 99 * B,
        pctChange: -2,
      },
      {
        ticker: "MSFT",
        name: "Microsoft Corporation",
        type: "CS",
        sector: "Technology Services",
        marketCap: 100 * B,
        pctChange: 2,
      },
    ]);
    const t = agg.get("Technology Services");
    expect(t.members).toBe(2);
    expect(t.weighted / t.capSum).toBeCloseTo(0, 6); // Alphabet counted once against Microsoft
  });

  it("ETFs do not move Finance (the audit: 42% of its weight was funds)", () => {
    const agg = aggregateSectors([
      {
        ticker: "JPM",
        name: "JPMorgan Chase & Co.",
        type: "CS",
        sector: "Finance",
        marketCap: 100 * B,
        pctChange: 1,
      },
      {
        ticker: "VTI",
        name: "Vanguard Total Stock Market ETF",
        type: "ETF",
        sector: "Finance",
        marketCap: 900 * B,
        pctChange: -3,
      },
      {
        ticker: "SPY",
        name: "SPDR S&P 500 ETF",
        type: "ETF",
        sector: "Finance",
        marketCap: 900 * B,
        pctChange: -3,
      },
    ]);
    const f = agg.get("Finance");
    expect(f.members).toBe(1);
    expect(f.weighted / f.capSum).toBe(1);
  });

  it("still skips delisted docs, missing weights or moves, and a sector with only funds", () => {
    const agg = aggregateSectors([
      {
        ticker: "OLD",
        name: "Old Co",
        type: "CS",
        sector: "Finance",
        marketCap: 5 * B,
        pctChange: 9,
        delisted: true,
      },
      {
        ticker: "NOCAP",
        name: "No Cap",
        type: "CS",
        sector: "Finance",
        marketCap: null,
        pctChange: 1,
      },
      {
        ticker: "NOMOVE",
        name: "No Move",
        type: "CS",
        sector: "Finance",
        marketCap: 5 * B,
        pctChange: null,
      },
      {
        ticker: "QQQ",
        name: "Invesco QQQ Trust",
        type: "ETF",
        sector: "Funds Only",
        marketCap: 5 * B,
        pctChange: 1,
      },
    ]);
    expect(agg.size).toBe(0);
  });
});
