import { ETFClassifier } from "./etf-classifier";

describe("ETFClassifier", () => {
  let classifier: ETFClassifier;

  beforeEach(() => {
    classifier = new ETFClassifier();
  });

  it("classifies VTI-like ETF as both Equity and Total Market", () => {
    const cats = classifier.classify({
      symbol: "VTI",
      name: "Vanguard Total Stock Market ETF",
      type: "ETF",
      assetClass: "Equity",
      focus: "Total Market",
    });
    expect(cats).toContain("largest");
    expect(cats).toContain("equity");
    expect(cats).toContain("totalMarket");
  });

  it("classifies VOO-like ETF as Equity but NOT Total Market", () => {
    const cats = classifier.classify({
      symbol: "VOO",
      name: "Vanguard S&P 500 ETF",
      type: "ETF",
      assetClass: "Equity",
      focus: "Large Cap",
    });
    expect(cats).toContain("largest");
    expect(cats).toContain("equity");
    expect(cats).not.toContain("totalMarket");
  });

  it("classifies GLD-like ETF as both Gold and Commodities", () => {
    const cats = classifier.classify({
      symbol: "GLD",
      name: "SPDR Gold Shares",
      type: "ETV",
      assetClass: "Commodities",
      focus: "Gold",
    });
    expect(cats).toContain("largest");
    expect(cats).toContain("gold");
    expect(cats).toContain("commodities");
    expect(cats).not.toContain("equity");
  });

  it("classifies BND-like ETF as Fixed Income", () => {
    const cats = classifier.classify({
      symbol: "BND",
      name: "Vanguard Total Bond Market ETF",
      type: "ETF",
      assetClass: "Fixed Income",
      focus: "Aggregate Bond",
    });
    expect(cats).toContain("largest");
    expect(cats).toContain("fixedIncome");
    expect(cats).not.toContain("equity");
  });

  it("classifies REIT ETF as Real Estate", () => {
    const cats = classifier.classify({
      symbol: "VNQ",
      name: "Vanguard Real Estate ETF",
      type: "ETF",
      assetClass: "Real Estate",
      focus: "REITs",
    });
    expect(cats).toContain("largest");
    expect(cats).toContain("realEstate");
  });

  it("classifies Bitcoin ETF dynamically via metadata without hardcoding ticker", () => {
    const cats = classifier.classify({
      symbol: "XYZBTC",
      name: "Spot Bitcoin Investment Trust ETF",
      type: "ETF",
      focus: "Bitcoin Strategy",
    });
    expect(cats).toContain("largest");
    expect(cats).toContain("bitcoin");
    expect(cats).not.toContain("equity");
  });

  it("classifies Ethereum ETF dynamically via metadata without hardcoding ticker", () => {
    const cats = classifier.classify({
      symbol: "XYZETH",
      name: "Fidelity Ethereum Fund Shares",
      type: "ETF",
      focus: "Ethereum",
    });
    expect(cats).toContain("largest");
    expect(cats).toContain("ethereum");
    expect(cats).not.toContain("equity");
  });

  it("classifies Leveraged S&P ETF as both Leveraged and Equity", () => {
    const cats = classifier.classify({
      symbol: "SPXL",
      name: "Direxion Daily S&P 500 Bull 3X Shares",
      type: "ETF",
      leverage: 3,
      strategy: "Leveraged Bull 3X",
    });
    expect(cats).toContain("largest");
    expect(cats).toContain("leveraged");
    expect(cats).toContain("equity");
  });

  it("classifies Commodity ETF as Commodities", () => {
    const cats = classifier.classify({
      symbol: "USO",
      name: "United States Oil Fund, LP",
      type: "ETV",
      assetClass: "Commodity",
      focus: "Crude Oil",
    });
    expect(cats).toContain("largest");
    expect(cats).toContain("commodities");
    expect(cats).not.toContain("equity");
  });

  it("distinguishes ultra-short duration bond fund from leveraged fund", () => {
    const cats = classifier.classify({
      symbol: "JPST",
      name: "JPMorgan Ultra-Short Income ETF",
      type: "ETF",
      assetClass: "Fixed Income",
    });
    expect(cats).toContain("fixedIncome");
    expect(cats).not.toContain("leveraged");
  });

  it("handles missing metadata, null values and strange capitalization gracefully", () => {
    const cats = classifier.classify({
      symbol: "TEST",
      name: "tEsT fIxEd-InCoMe BoNd fUnD",
      assetClass: undefined,
      focus: null as any,
      description: null as any,
      leverage: null,
    });
    expect(cats).toContain("largest");
    expect(cats).toContain("fixedIncome");
  });

  it("does not classify non-gold funds as gold just because Goldman is the issuer", () => {
    const cats = classifier.classify({
      symbol: "GSLC",
      name: "Goldman Sachs ActiveBeta U.S. Large Cap Equity ETF",
      type: "ETF",
      assetClass: "Equity",
    });
    expect(cats).not.toContain("gold");
    expect(cats).toContain("equity");
  });

  it("correctly classifies Goldman Sachs Physical Gold ETF as gold", () => {
    const cats = classifier.classify({
      symbol: "AAAU",
      name: "Goldman Sachs Physical Gold ETF Shares",
      type: "ETF",
    });
    expect(cats).toContain("gold");
    expect(cats).toContain("commodities");
  });
});
