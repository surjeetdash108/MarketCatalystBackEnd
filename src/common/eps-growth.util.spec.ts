import { fyDilutedEpsGrowth } from "./eps-growth.util";

describe("FY diluted EPS growth (same statement as revenue growth)", () => {
  it("MU FY2026: +879.3%", () =>
    expect(fyDilutedEpsGrowth({ growthEPSDiluted: 8.7926 })).toBe(8.7926));
  it("absent or beyond ±1000% → null", () => {
    expect(fyDilutedEpsGrowth({})).toBeNull();
    expect(fyDilutedEpsGrowth({ growthEPSDiluted: 49.1 })).toBeNull();
    expect(fyDilutedEpsGrowth(null)).toBeNull();
  });
});
