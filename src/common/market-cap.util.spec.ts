import { reconcileMarketCap } from "./validate.util";

describe("reconcileMarketCap", () => {
  it("uses current price × shares, not a stored value computed at an older price (BGS)", () => {
    expect(reconcileMarketCap(165e6, 2.1, 81_275_671)).toBeCloseTo(170.68e6, -4);
  });
  it("falls back to the stored value, then null", () => {
    expect(reconcileMarketCap(165e6, null, 81_275_671)).toBe(165e6);
    expect(reconcileMarketCap(null, null, null)).toBeNull();
  });
});
