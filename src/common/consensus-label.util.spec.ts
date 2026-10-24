import { consensusLabel, consensusMean } from "./consensus-label.util";

describe("consensusLabel", () => {
  it("labels on the published 1–5 bands (mean ≤ 2.5 is Buy)", () => {
    expect(consensusLabel({ buy: 5, hold: 5 })).toBe("Buy"); // mean 2.5 exactly (BJRI)
    expect(consensusLabel({ strongBuy: 1, buy: 12, hold: 12 })).toBe("Buy"); // KR 2.44
    expect(consensusLabel({ strongBuy: 1, buy: 10, hold: 22 })).toBe("Hold"); // EOG 2.64
    expect(consensusLabel({ strongBuy: 2 })).toBe("Strong Buy");
    expect(consensusLabel({ sell: 1, strongSell: 3 })).toBe("Strong Sell");
  });
  it("is null without ratings", () => {
    expect(consensusLabel({})).toBeNull();
    expect(consensusMean({ buy: null, hold: 0 })).toBeNull();
  });
});
