import {
  dividendTypeFor,
  etMidnightMs,
  etWallToEpochMs,
  exchangeToMic,
  frequencyToLabel,
  frequencyToNumber,
  fromFmpSymbol,
  ipoStatusFor,
  isUsSymbol,
  micFromFmpExchange,
  normalizePriceRange,
  parseEodBulkCsv,
  sessionPhase,
  toFmpSymbol,
} from "./fmp-mapping.util";

describe("fmp-mapping.util", () => {
  it("converts FMP ET wall-clock stamps across DST", () => {
    // EDT (UTC−4) in October, EST (UTC−5) in January.
    expect(new Date(etWallToEpochMs("2026-10-16 09:30:00")).toISOString()).toBe("2026-10-16T13:30:00.000Z");
    expect(new Date(etWallToEpochMs("2026-01-15 09:30:00")).toISOString()).toBe("2026-01-15T14:30:00.000Z");
    // The night clocks fall back (1 Nov 2026): 00:00 is still EDT.
    expect(new Date(etMidnightMs("2026-11-01")).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(new Date(etMidnightMs("2026-11-02")).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("maps class-share symbols between Polygon and FMP", () => {
    expect(toFmpSymbol("BRK.B")).toBe("BRK-B");
    expect(toFmpSymbol("aapl")).toBe("AAPL");
    expect(fromFmpSymbol("BRK-B")).toBe("BRK.B");
    expect(fromFmpSymbol("AAPL")).toBe("AAPL");
  });

  it("keeps US-shaped symbols out of FMP's global feeds", () => {
    expect(["AAPL", "BRK-B", "GOOGL"].every(isUsSymbol)).toBe(true);
    expect(["AMD.TO", "^GSPC", "600000.SS", "002241.SZ", "2723.HK"].some(isUsSymbol)).toBe(false);
  });

  it("maps dividend frequency into Polygon's vocabularies", () => {
    expect(frequencyToNumber("Quarterly")).toBe(4);
    expect(frequencyToNumber("Irregular")).toBe(0);
    expect(frequencyToNumber("weird")).toBeNull();
    expect(frequencyToLabel("Monthly")).toBe("Monthly");
    expect(frequencyToLabel("Irregular")).toBe("One-Time");
    expect(dividendTypeFor("Quarterly")).toBe("CD");
    expect(dividendTypeFor("Irregular")).toBe("SC");
  });

  it("maps FMP IPO actions onto the statuses the IPO screen keys on", () => {
    expect(ipoStatusFor("Expected", "2026-10-20", "2026-10-16")).toBe("pending");
    expect(ipoStatusFor("Priced", "2026-10-16", "2026-10-16")).toBe("priced");
    expect(ipoStatusFor("Priced", "2026-10-01", "2026-10-16")).toBe("history");
    expect(ipoStatusFor("Withdrawn", "2026-10-01", "2026-10-16")).toBe("withdrawn");
  });

  it("normalises IPO price ranges", () => {
    expect(normalizePriceRange("5 - 5")).toEqual({ price: "5", single: 5 });
    expect(normalizePriceRange("18.00 - 20.00")).toEqual({ price: "18-20", single: null });
    expect(normalizePriceRange(null)).toEqual({ price: null, single: null });
  });

  it("maps exchanges to Polygon MICs", () => {
    expect(exchangeToMic("NASDAQ")).toBe("XNAS");
    expect(exchangeToMic("NYSE")).toBe("XNYS");
    expect(exchangeToMic("AMEX")).toBe("XASE");
    expect(exchangeToMic("NYSE Arca")).toBe("ARCX");
  });

  it("maps FMP's full exchange names to MICs, separating NYSE Arca from NYSE American", () => {
    // Screener short codes call both Arca and American "AMEX"; the full name decides.
    expect(micFromFmpExchange("New York Stock Exchange Arca", "AMEX")).toBe("ARCX");
    expect(micFromFmpExchange("NYSE American", "AMEX")).toBe("XASE");
    expect(micFromFmpExchange("New York Stock Exchange", "NYSE")).toBe("XNYS");
    expect(micFromFmpExchange("NASDAQ Global Select", "NASDAQ")).toBe("XNAS");
    expect(micFromFmpExchange("CBOE BZX", "CBOE")).toBe("BATS");
    expect(micFromFmpExchange("", "NASDAQ")).toBe("XNAS");
    expect(micFromFmpExchange(null)).toBeNull();
  });

  it("parses the eod-bulk CSV", () => {
    const csv = `"symbol","date","open","low","high","close","adjClose","volume"\n"AAPL","2026-10-15",340,339,345,344,344,51000000\n"BAD","2026-10-15",x,1,1,1,1,1\n`;
    expect(parseEodBulkCsv(csv)).toEqual([
      { symbol: "AAPL", date: "2026-10-15", open: 340, high: 345, low: 339, close: 344, volume: 51000000 },
    ]);
  });

  it("derives the session phase from the ET clock", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(sessionPhase(at("2026-10-16T12:00:00Z"))).toBe("pre"); // 08:00 ET
    expect(sessionPhase(at("2026-10-16T14:00:00Z"))).toBe("open"); // 10:00 ET
    expect(sessionPhase(at("2026-10-16T21:00:00Z"))).toBe("post"); // 17:00 ET
    expect(sessionPhase(at("2026-10-17T15:00:00Z"))).toBe("closed"); // Saturday
    expect(sessionPhase(at("2026-11-27T18:30:00Z"), 13 * 60)).toBe("post"); // 13:30 ET, early close
  });
});
