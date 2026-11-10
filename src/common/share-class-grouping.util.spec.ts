import { groupShareClassesByCik } from "./share-class-grouping.util";

describe("share-class-grouping.util", () => {
  it("groups duplicate share classes sharing the same SEC CIK and retains largest market cap", () => {
    const constituents = [
      { ticker: "GOOGL", marketCap: 2_100_000_000_000, pctChange: 1.25, cik: "0001652044" },
      { ticker: "GOOG",  marketCap: 2_050_000_000_000, pctChange: 1.15, cik: "0001652044" },
      { ticker: "MSFT",  marketCap: 3_100_000_000_000, pctChange: -0.45, cik: "0000789019" },
    ];

    const deduplicated = groupShareClassesByCik(constituents);

    // GOOGL and GOOG grouped into one; GOOGL retained because marketCap 2.1T > 2.05T
    expect(deduplicated.map(c => c.ticker)).toEqual(["MSFT", "GOOGL"]);
    expect(deduplicated.length).toBe(2);
  });

  it("handles companies without CIK by preserving their distinct tickers", () => {
    const constituents = [
      { ticker: "AAPL", marketCap: 3_500_000_000_000, pctChange: 0.8 },
      { ticker: "NVDA", marketCap: 3_300_000_000_000, pctChange: 2.1 },
    ];

    const deduplicated = groupShareClassesByCik(constituents);
    expect(deduplicated.map(c => c.ticker)).toEqual(["AAPL", "NVDA"]);
  });

  it("sorts deduplicated items by market cap descending", () => {
    const constituents = [
      { ticker: "SMALL", marketCap: 50_000_000_000, pctChange: 0.1, cik: "111" },
      { ticker: "BIG", marketCap: 500_000_000_000, pctChange: -0.2, cik: "222" },
      { ticker: "BIG.B", marketCap: 450_000_000_000, pctChange: -0.3, cik: "222" },
    ];

    const deduplicated = groupShareClassesByCik(constituents);
    expect(deduplicated.map(c => c.ticker)).toEqual(["BIG", "SMALL"]);
  });
});
