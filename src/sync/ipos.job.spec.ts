import { offerPrice } from "./ipos.job";

describe("offerPrice", () => {
  it("uses the final issue price over the range midpoint", () => {
    // TRXB: range 14-16, priced at 14.
    expect(offerPrice(14, 14, 16)).toBe(14);
  });

  it("falls back to the range midpoint before the IPO prices", () => {
    expect(offerPrice(null, 17, 19)).toBe(18);
    expect(offerPrice(undefined, 15, 17)).toBe(16);
  });

  it("ignores a non-positive final price", () => {
    expect(offerPrice(0, 14, 16)).toBe(15);
  });

  it("uses whichever bound exists when the range is one-sided", () => {
    expect(offerPrice(null, 12, null)).toBe(12);
    expect(offerPrice(null, null, 13)).toBe(13);
  });

  it("is null with no price at all", () => {
    expect(offerPrice(null, null, null)).toBeNull();
  });
});
