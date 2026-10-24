import { classifyFromSic, classifyFromVendorIndustry, withTickerOverride, withVendorIndustryFallback } from "./sic-tv.util";

describe("classifyFromSic ticker overrides", () => {
  it("classifies bitcoin-mining / AI-compute operators as Technology Services, not Finance", () => {
    expect(classifyFromSic(6199, "IREN")).toEqual({
      sector: "Technology Services",
      industry: "Data Processing Services",
    });
    expect(classifyFromSic(6199, "mara").sector).toBe("Technology Services");
  });

  it("leaves every other ticker on its SIC classification", () => {
    expect(classifyFromSic(6199, "SCHW")).toEqual(classifyFromSic(6199));
    expect(classifyFromSic(3674, "NVDA")).toEqual(classifyFromSic(3674));
  });

  it("corrects stored docs at read time and leaves others untouched", () => {
    const iren = { ticker: "IREN", sector: "Finance", industry: "Finance/Rental/Leasing", price: 40 };
    expect(withTickerOverride(iren)).toEqual({
      ticker: "IREN",
      sector: "Technology Services",
      industry: "Data Processing Services",
      price: 40,
    });
    const jpm = { ticker: "JPM", sector: "Finance", industry: "Major Banks" };
    expect(withTickerOverride(jpm)).toBe(jpm);
  });
});

describe("SIC mapping fixes (E2E Oct 2026, category C)", () => {
  const sector = (sic: number, t?: string) => classifyFromSic(sic, t).sector;
  it("puts dealers and auto-parts stores in retail, rental in finance", () => {
    expect(classifyFromSic(5500)).toEqual({ sector: "Retail Trade", industry: "Specialty Stores" }); // AN
    expect(sector(5531)).toBe("Retail Trade"); // HZO
    expect(classifyFromSic(7510)).toEqual({ sector: "Finance", industry: "Finance/Rental/Leasing" }); // CAR
  });
  it("classifies consumer goods as consumer, not manufacturing / electronics / process", () => {
    expect(sector(3942)).toBe("Consumer Durables"); // MAT
    expect(sector(3949)).toBe("Consumer Durables"); // CLAR
    expect(sector(3873)).toBe("Consumer Durables"); // MOV
    expect(sector(3420)).toBe("Consumer Durables"); // LCUT
    expect(classifyFromSic(3021)).toEqual({ sector: "Consumer Non-Durables", industry: "Apparel/Footwear" }); // CROX
    expect(classifyFromSic(3730).industry).toBe("Recreational Products"); // MCFT
  });
  it("puts gas distribution utilities in Utilities and office furniture in Producer Manufacturing", () => {
    expect(classifyFromSic(4923)).toEqual({ sector: "Utilities", industry: "Gas Distributors" }); // RGCO
    expect(classifyFromSic(4922).industry).toBe("Oil & Gas Pipelines"); // pipelines unchanged
    expect(classifyFromSic(2520)).toEqual({ sector: "Producer Manufacturing", industry: "Office Equipment/Supplies" }); // MLKN
  });
  it("overrides legacy SIC codes for COP, GE and TMO", () => {
    expect(classifyFromSic(2911, "COP").industry).toBe("Oil & Gas Production");
    expect(classifyFromSic(3600, "GE")).toEqual({ sector: "Electronic Technology", industry: "Aerospace & Defense" });
    expect(classifyFromSic(3829, "TMO").sector).toBe("Health Technology");
  });
  it("falls back to the vendor industry only when there is no SIC (PFBC)", () => {
    expect(withVendorIndustryFallback(classifyFromSic(null), "Banks - Regional")).toEqual({ sector: "Finance", industry: "Regional Banks" });
    expect(withVendorIndustryFallback(classifyFromSic(5500), "Banks - Regional").industry).toBe("Specialty Stores");
    expect(classifyFromVendorIndustry("REIT - Office").industry).toBe("Real Estate Investment Trusts");
    expect(classifyFromVendorIndustry("Something Unmapped")).toEqual({ sector: null, industry: null });
  });
});
