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

import { dedupeIssuers, isFundType, issuerKey } from "./share-class-grouping.util";

describe("stock-map membership (no CIK on any company doc)", () => {
  const B = 1e9;
  const docs = [
    { ticker: "GOOGL", name: "Alphabet Inc.", type: "CS", marketCap: 3441 * B },
    { ticker: "GOOG", name: "Alphabet Inc.", type: "CS", marketCap: 3438 * B },
    { ticker: "GOOGM", name: "Alphabet Inc. Depository Shs Repr 1/20th Conv Pfd Registered Shs", type: "CS", marketCap: 3547 * B },
    { ticker: "BRK.A", name: "Berkshire Hathaway Inc.", type: "CS", marketCap: 1229 * B },
    { ticker: "BRK.B", name: "Berkshire Hathaway Inc.", type: "CS", marketCap: 800 * B },
    { ticker: "VTI", name: "Vanguard Morningstar Total Stock Market ETF", type: "ETF", marketCap: 2182 * B },
    { ticker: "JPM", name: "JPMorgan Chase & Co.", type: "CS", marketCap: 841 * B },
    { ticker: "NODOC", name: null, marketCap: 5 * B },
  ];

  it("Alphabet's three listings and Berkshire's two each count once; the ETF is dropped", () => {
    const out = dedupeIssuers(docs);
    // GOOGL survives, not GOOGM: the depositary share has the biggest (wrong) cap but is not the common stock
    expect(out.map((d) => d.ticker)).toEqual(["GOOGL", "BRK.A", "JPM", "NODOC"]);
  });

  it("the depositary share of the preferred collapses onto Alphabet", () => {
    expect(issuerKey(docs[2])).toBe(issuerKey(docs[0]));
    expect(issuerKey(docs[3])).toBe(issuerKey(docs[4]));
  });

  it("a doc with no name keys on its own ticker; a CIK wins over the name", () => {
    expect(issuerKey({ ticker: "NODOC", name: null })).toBe("TKR_NODOC");
    expect(issuerKey({ ticker: "A", name: "Alphabet Inc.", cik: "0001652044" })).toBe("CIK_1652044");
  });

  it("class wording is stripped (Under Armour Class A / Class C)", () => {
    expect(issuerKey({ ticker: "UAA", name: "Under Armour, Inc. Class A" })).toBe(issuerKey({ ticker: "UA", name: "Under Armour, Inc. Class C" }));
  });

  it("isFundType: ETF, ETN, ETV, FUND only", () => {
    expect(["ETF", "ETN", "ETV", "FUND", "etf"].every((t) => isFundType(t))).toBe(true);
    expect(["CS", "ADRC", "PFD", null, undefined].some((t) => isFundType(t as string))).toBe(false);
  });
});
