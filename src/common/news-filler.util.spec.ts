import { isFillerNews, looksLikeDealButIsNot } from "./news-filler.util";

describe("isFillerNews", () => {
  it("flags 13F holdings boilerplate", () => {
    // defenseworld.net churns these out — 96 of 300 served articles.
    expect(isFillerNews("Apple Inc. $AAPL Shares Acquired by Balefire LLC")).toBe(true);
    expect(isFillerNews("AbbVie Inc. Shares Sold by ABN Amro Investment Solutions")).toBe(true);
    expect(isFillerNews("Vanguard Group Inc. Position Boosted by Some Fund")).toBe(true);
  });

  it("flags listicle and opinion clickbait", () => {
    for (const h of [
      "2 Top Growth Stocks to Buy Right Now Without Any Hesitation",
      "1 Unstoppable Stock to Buy Before It Joins Nvidia",
      "The Smartest ETF to Buy With $750 Right Now",
      "Prediction: Nvidia Will Be a $6 Trillion Company Before 2026 Is Over",
      "Is It Finally Time to Buy Alphabet?",
      "Better Buy: AMD or Intel",
    ]) expect(isFillerNews(h)).toBe(true);
  });

  it("flags known syndication publishers outright", () => {
    expect(isFillerNews("Some ordinary headline", null, "defenseworld.net")).toBe(true);
    expect(isFillerNews("Some ordinary headline", null, "MarketBeat.com")).toBe(true);
  });

  it("does NOT flag real news", () => {
    for (const h of [
      "Uber faces fine of nearly $1B over automated driver suspensions",
      "Nvidia beats Q2 estimates on data-centre demand",
      "Broadcom acquires VMware",
      "Morgan Stanley upgrades Ford to Overweight",
      "This Company Has Raised Its Dividend for 72 Straight Years",
    ]) expect(isFillerNews(h, null, "Reuters")).toBe(false);
  });

  it("only reads the headline, so a real article mentioning a stake survives", () => {
    expect(isFillerNews(
      "Broadcom acquires VMware",
      "Separately, a fund's position was boosted by 4% last quarter.",
      "Reuters",
    )).toBe(false);
  });

  it("handles empty input", () => {
    expect(isFillerNews("")).toBe(false);
    expect(isFillerNews(null)).toBe(false);
  });

  it("shares its patterns with the M&A guard", () => {
    expect(looksLikeDealButIsNot("$AAPL Shares Acquired by Balefire LLC")).toBe(true);
    expect(looksLikeDealButIsNot("Broadcom acquires VMware")).toBe(false);
  });
});
