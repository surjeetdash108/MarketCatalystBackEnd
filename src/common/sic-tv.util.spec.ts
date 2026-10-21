import { classifyFromSic, withTickerOverride } from "./sic-tv.util";

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
