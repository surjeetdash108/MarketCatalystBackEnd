import { formatRecapIndices, nasdaqCompositeQuote, type IndexRow } from "./recap-indices.util";

describe("recap indices formatting", () => {
  it("labels QQQ/NDX as 'Nasdaq-100' and assigns Nasdaq Composite (^IXIC) to 'Nasdaq'", () => {
    const input: IndexRow[] = [
      { id: "SPX", label: "S&P 500", value: 7634.7, pctChange: -0.29, isProxy: true, proxyTicker: "SPY" },
      { id: "NDX", label: "Nasdaq", value: 25639.42, pctChange: -0.99, isProxy: true, proxyTicker: "QQQ" }, // old bug: NDX labeled "Nasdaq"
      { id: "DJI", label: "Dow", value: 53365, pctChange: 0.27, isProxy: true, proxyTicker: "DIA" },
    ];

    const ixicQuote = { price: 25955.34, pctChange: -0.21, change: -53.52 };
    const formatted = formatRecapIndices(input, ixicQuote);

    const nasdaq = formatted.find((i) => i.label === "Nasdaq");
    expect(nasdaq).toBeDefined();
    expect(nasdaq?.value).toBe(25955.34);
    expect(nasdaq?.pctChange).toBe(-0.21);

    const ndx = formatted.find((i) => i.id === "NDX");
    expect(ndx?.label).toBe("Nasdaq-100");
  });

  it("labels QQQ/NDX as 'Nasdaq-100' even when no ixicQuote is provided", () => {
    const input: IndexRow[] = [
      { id: "NDX", label: "Nasdaq", value: 25639.42, pctChange: -0.99, isProxy: true, proxyTicker: "QQQ" },
    ];
    const formatted = formatRecapIndices(input);
    expect(formatted[0].label).toBe("Nasdaq-100");
  });
});

describe("recap Nasdaq Composite row (Oct 23 2026 close)", () => {
  // Real FMP EOD rows; the quote is what /stable/quote returns after that close:
  // last price = Oct 23 close, previousClose = Oct 22 close.
  const fx = JSON.parse(
    require("fs").readFileSync(require("path").join(__dirname, "fixtures/nasdaq-oct23.json"), "utf-8"),
  );
  const [oct23, oct22] = fx.IXIC;
  const fmp = {
    getQuote: jest.fn(async (symbol: string) =>
      symbol === "^IXIC"
        ? { price: oct23.close, previousClose: oct22.close, changePercentage: (oct23.close / oct22.close - 1) * 100 }
        : null,
    ),
  };
  const [qqq23, qqq22] = fx.QQQ;
  const stored: IndexRow[] = [
    { id: "SPX", label: "S&P 500", value: null, pctChange: null, isProxy: true, proxyTicker: "SPY" },
    { id: "NDX", label: "Nasdaq-100", value: null, pctChange: Math.round((qqq23.close / qqq22.close - 1) * 10000) / 100, isProxy: true, proxyTicker: "QQQ" },
  ];

  it("the recap shows the Nasdaq Composite, change from the previous close", async () => {
    const out = formatRecapIndices(stored, await nasdaqCompositeQuote(fmp));
    expect(fmp.getQuote).toHaveBeenCalledWith("^IXIC");
    const nasdaq = out.find((r) => r.label === "Nasdaq");
    expect(nasdaq).toMatchObject({ id: "IXIC", value: 25955.34, pctChange: -0.21, change: -53.52, isProxy: false });
    // Placed after the S&P 500, and the QQQ proxy stays labelled as what it is.
    expect(out.map((r) => r.label)).toEqual(["S&P 500", "Nasdaq", "Nasdaq-100"]);
  });

  it("no FMP quote: no Nasdaq row is invented", async () => {
    const out = formatRecapIndices(stored, await nasdaqCompositeQuote({ getQuote: async () => null }));
    expect(out.find((r) => r.label === "Nasdaq")).toBeUndefined();
  });
});
