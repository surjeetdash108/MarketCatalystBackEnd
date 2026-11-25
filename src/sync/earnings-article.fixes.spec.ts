import { formatEps, gapText } from "./earnings-article.facts";

describe("scorecard fixes (24 Nov 2026 audit)", () => {
  it("B-11: a near-zero estimate states the gap in cents, not 76033%", () => {
    expect(gapText("eps", 7.61, 0.01)).toBe("Beat by $7.60");
    expect(gapText("eps", 0.14, 0.01)).toBe("Beat by $0.13");
    expect(gapText("eps", 1.2, 1.0)).toBe("Beat by 20%");
  });
  it("B-13: a value that rounds to zero is $0.00, never -$0.00", () => {
    expect(formatEps(-0.001)).toBe("$0.00");
    expect(formatEps(-0.05)).toBe("-$0.05");
  });
});
