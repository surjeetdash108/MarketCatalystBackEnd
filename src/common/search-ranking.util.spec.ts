import { rankSearchCandidates } from "./search-ranking.util";

describe("search ranking (exact ticker, then prefix, then name)", () => {
  const universe = [
    { ticker: "MSFT", name: "Microsoft Corporation" },
    { ticker: "AAPL", name: "Apple Inc." },
    { ticker: "TSLA", name: "Tesla, Inc." },
    { ticker: "T", name: "AT&T Inc." },
    { ticker: "TXN", name: "Texas Instruments Incorporated" },
    { ticker: "TM", name: "Toyota Motor Corporation" },
    { ticker: "COST", name: "Costco Wholesale Corporation" },
  ];

  it("ranks exact ticker first when searching 'T', followed by ticker prefix, then name prefix, then substring", () => {
    const ranked = rankSearchCandidates(universe, "T");
    expect(ranked[0].ticker).toBe("T");
    expect(ranked.slice(0, 4).map((r) => r.ticker)).toEqual(["T", "TSLA", "TXN", "TM"]);
    // COST and MSFT are substring matches only and should be at the end
    expect(ranked[ranked.length - 1].ticker).toBe("COST");
  });

  it("ranks prefix matches correctly for multi-character query", () => {
    const ranked = rankSearchCandidates(universe, "TS");
    expect(ranked[0].ticker).toBe("TSLA");
  });
});
