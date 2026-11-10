import { resolveDisplayQuote } from "./quote-parity.util";

describe("quote-parity.util", () => {
  it("resolves from primary shared quote atomically without mixing price and change sources", () => {
    const sharedQuote = { price: 523.31, pctChange: 0.43 };
    const liveTick = { price: 524.51, pctChange: 0.66 };
    const snapshot = { price: 520.00, pctChange: -0.10 };

    const resolved = resolveDisplayQuote({
      sharedQuote,
      liveTick,
      snapshot,
    });

    // Must match the shared quote (used on dashboard tile, heatmap)
    expect(resolved.price).toBe(523.31);
    expect(resolved.pctChange).toBe(0.43);
    expect(resolved.source).toBe("sharedQuote");
  });

  it("falls back to live tick atomically when shared quote has no price", () => {
    const liveTick = { price: 524.51, pctChange: 0.66 };
    const snapshot = { price: 520.00, pctChange: -0.10 };

    const resolved = resolveDisplayQuote({
      sharedQuote: null,
      liveTick,
      snapshot,
    });

    expect(resolved.price).toBe(524.51);
    expect(resolved.pctChange).toBe(0.66);
    expect(resolved.source).toBe("liveTick");
  });

  it("never pairs price from one source with pctChange from a different source", () => {
    // If sharedQuote only has price, do not take pctChange from liveTick (which belongs to a different moment)
    const partialShared = { price: 523.31, pctChange: null };
    const liveTick = { price: 524.51, pctChange: 0.66 };

    const resolved = resolveDisplayQuote({
      sharedQuote: partialShared,
      liveTick,
    });

    // Entire complete pair from liveTick preferred over desynchronized partial
    expect(resolved.price).toBe(524.51);
    expect(resolved.pctChange).toBe(0.66);
  });
});
