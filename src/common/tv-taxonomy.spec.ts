import {
  TV_SECTORS,
  TV_INDUSTRIES,
  TV_INDUSTRIES_BY_SECTOR,
  isTvSector,
  isTvIndustry,
  sectorForIndustry,
} from "./tv-taxonomy";
import { classifyFromSic } from "./sic-tv.util";

/**
 * These lock the classification down so it cannot silently drift back to the
 * old GICS/SPDR names or start emitting raw vendor strings — the two failures
 * that left 133 of 569 company docs with a wrong or missing sector.
 */
describe("TradingView taxonomy", () => {
  it("has TradingView's exact shape: 20 sectors, 128 industries", () => {
    expect(TV_SECTORS).toHaveLength(20);
    expect(TV_INDUSTRIES).toHaveLength(128);
  });

  it("contains no duplicate sector or industry names", () => {
    expect(new Set(TV_SECTORS).size).toBe(TV_SECTORS.length);
    expect(new Set(TV_INDUSTRIES).size).toBe(TV_INDUSTRIES.length);
  });

  it("rolls every industry up to exactly one known sector", () => {
    for (const industry of TV_INDUSTRIES) {
      const sector = sectorForIndustry(industry);
      expect(sector).not.toBeNull();
      expect(isTvSector(sector)).toBe(true);
    }
  });

  it("groups only known industries under each sector", () => {
    for (const sector of TV_SECTORS) {
      for (const industry of TV_INDUSTRIES_BY_SECTOR[sector]) {
        expect(isTvIndustry(industry)).toBe(true);
      }
    }
  });

  // "1st letter will be capital everywhere" — the old scheme leaked raw SIC
  // descriptions in SHOUTING CAPS ("FIRE, MARINE & CASUALTY INSURANCE").
  it("starts every sector and industry with a capital letter", () => {
    for (const v of [...TV_SECTORS, ...TV_INDUSTRIES]) {
      expect(v[0]).toBe(v[0].toUpperCase());
      expect(v[0]).toMatch(/[A-Z]/);
    }
  });

  it("never emits an ALL-CAPS name (the raw-SIC signature)", () => {
    for (const v of [...TV_SECTORS, ...TV_INDUSTRIES]) {
      const letters = v.replace(/[^A-Za-z]/g, "");
      expect(letters).not.toBe(letters.toUpperCase());
    }
  });

  it("rejects every name from the retired GICS/SPDR scheme", () => {
    for (const old of [
      "Technology",
      "Financial Services",
      "Healthcare",
      "Consumer Cyclical",
      "Consumer Defensive",
      "Basic Materials",
      "Communication Services",
      "Industrials",
      "Real Estate",
      "Crypto / Blockchain",
    ]) {
      expect(isTvSector(old)).toBe(false);
    }
  });
});

describe("classifyFromSic", () => {
  // Each expectation is the classification TradingView itself shows.
  const CASES: Array<[number, string, string, string]> = [
    [3674, "NVDA", "Electronic Technology", "Semiconductors"],
    [3571, "AAPL", "Electronic Technology", "Computer Processing Hardware"],
    [7372, "MSFT", "Technology Services", "Packaged Software"],
    [7370, "GOOGL", "Technology Services", "Internet Software/Services"],
    [5961, "AMZN", "Retail Trade", "Internet Retail"],
    [2834, "LLY", "Health Technology", "Pharmaceuticals: Major"],
    [2836, "AMGN", "Health Technology", "Biotechnology"],
    [6021, "JPM", "Finance", "Major Banks"],
    [6798, "REIT", "Finance", "Real Estate Investment Trusts"],
    [1311, "XOM", "Energy Minerals", "Oil & Gas Production"],
    [4911, "utility", "Utilities", "Electric Utilities"],
    [5812, "MCD", "Consumer Services", "Restaurants"],
    [3711, "TSLA", "Consumer Durables", "Motor Vehicles"],
    [3721, "BA", "Electronic Technology", "Aerospace & Defense"],
    [8062, "HCA", "Health Services", "Hospital/Nursing Management"],
    [3312, "NUE", "Non-Energy Minerals", "Steel"],
  ];

  it.each(CASES)(
    "SIC %i (%s) -> %s / %s",
    (sic, _who, sector, industry) => {
      expect(classifyFromSic(sic)).toEqual({ sector, industry });
    },
  );

  it("keeps sector and industry consistent for every mapped code", () => {
    for (let sic = 100; sic <= 9999; sic++) {
      const { sector, industry } = classifyFromSic(sic);
      if (!industry) continue;
      expect(isTvIndustry(industry)).toBe(true);
      expect(sector).toBe(sectorForIndustry(industry));
    }
  });

  it("returns nulls rather than guessing on unusable input", () => {
    for (const bad of [null, undefined, "", "n/a", 0, -1, NaN]) {
      expect(classifyFromSic(bad as never)).toEqual({
        sector: null,
        industry: null,
      });
    }
  });

  it("accepts a SIC code given as a string, as Polygon returns it", () => {
    expect(classifyFromSic("3674")).toEqual(classifyFromSic(3674));
  });

  it("prefers the exact 4-digit code over its major group", () => {
    // 28 is Chemicals, but 2834 is pharma; 35 is Machinery, but 3571 is computers.
    expect(classifyFromSic(2834).sector).toBe("Health Technology");
    expect(classifyFromSic(2810).sector).toBe("Process Industries");
    expect(classifyFromSic(3571).sector).toBe("Electronic Technology");
    expect(classifyFromSic(3540).sector).toBe("Producer Manufacturing");
  });

  it("classifies a newly-listed ticker from its SIC alone, with no vendor label", () => {
    // The "future tickers" guarantee: nothing but the SIC code is required.
    expect(classifyFromSic(3674)).toEqual({
      sector: "Electronic Technology",
      industry: "Semiconductors",
    });
  });
});
