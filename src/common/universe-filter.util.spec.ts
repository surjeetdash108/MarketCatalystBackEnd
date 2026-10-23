import { isCommonEquity } from "./universe-filter.util";

describe("universe-filter.util", () => {
  describe("isCommonEquity", () => {
    it("accepts valid common equity and ADR with sector", () => {
      expect(
        isCommonEquity({
          ticker: "AAPL",
          name: "Apple Inc.",
          sector: "Technology",
          type: "CS",
          isEtf: false,
        }),
      ).toBe(true);

      expect(
        isCommonEquity({
          ticker: "MFG",
          name: "Mizuho Financial Group Inc ADR",
          sector: "Financial Services",
          type: "ADRC",
          isEtf: false,
        }),
      ).toBe(true);
    });

    it("rejects ETFs using type, isEtf flag, and metadata descriptors (e.g. ANV, SNDC)", () => {
      // ANV: YieldMax NVDA Option Income Strategy ETF
      expect(
        isCommonEquity({
          ticker: "ANV",
          name: "YieldMax NVDA Option Income Strategy ETF",
          sector: "Financial Services",
          type: "ETF",
          isEtf: true,
        }),
      ).toBe(false);

      expect(
        isCommonEquity({
          ticker: "SNDC",
          name: "US Benchmark ETF",
          sector: "Financial Services",
          type: "ETF",
          isEtf: true,
        }),
      ).toBe(false);
    });

    it("rejects preferred stocks using type and metadata descriptors (e.g. FCNCN)", () => {
      // FCNCN: First Citizens BancShares Inc. 5.625% Non-Cumulative Perpetual Preferred Stock
      expect(
        isCommonEquity({
          ticker: "FCNCN",
          name: "First Citizens BancShares 5.625% Preferred Stock Series C",
          sector: "Financial Services",
          type: "PFD",
        }),
      ).toBe(false);
    });

    it("rejects warrants and odd derivative instruments (e.g. XRPNW)", () => {
      // XRPNW: Defiance Daily Target 2X Long XRP ETF Warrant
      expect(
        isCommonEquity({
          ticker: "XRPNW",
          name: "Defiance Daily Target 2X Long XRP ETF Warrant",
          sector: "Financial Services",
          type: "WARRANT",
        }),
      ).toBe(false);
    });

    it("rejects sector-less or unclassified symbols (e.g. USDE, MUU)", () => {
      expect(
        isCommonEquity({
          ticker: "USDE",
          name: "USDE Token / Currency Trust",
          sector: "—",
          type: "CS",
        }),
      ).toBe(false);

      expect(
        isCommonEquity({
          ticker: "MUU",
          name: "MUU Unknown Unit",
          sector: null,
          type: "UNIT",
        }),
      ).toBe(false);
    });
  });
});
