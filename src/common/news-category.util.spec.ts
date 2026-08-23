import { categoriseNews, NEWS_CATEGORY_ORDER, NEWS_CATEGORY_LABEL } from "./news-category.util";

describe("categoriseNews", () => {
  it("labels every category and keeps Other last", () => {
    expect(NEWS_CATEGORY_ORDER).toHaveLength(7);
    expect(NEWS_CATEGORY_ORDER[NEWS_CATEGORY_ORDER.length - 1]).toBe("other");
    for (const c of NEWS_CATEGORY_ORDER) expect(NEWS_CATEGORY_LABEL[c]).toBeTruthy();
  });

  it("earnings", () => {
    expect(categoriseNews("Nvidia beats Q2 estimates on data-centre demand")).toBe("earnings");
    expect(categoriseNews("Acme reports third quarter results")).toBe("earnings");
    expect(categoriseNews("Coca-Cola Just Raised Its Full-Year Guidance")).toBe("earnings");
  });

  it("analyst actions", () => {
    expect(categoriseNews("Morgan Stanley upgrades Ford to Overweight")).toBe("analyst");
    expect(categoriseNews("Goldman raises price target on AAPL to $310")).toBe("analyst");
    expect(categoriseNews("Barclays initiates coverage on RDDT")).toBe("analyst");
  });

  it("M&A", () => {
    expect(categoriseNews("Salesforce to acquire Informatica for $8B")).toBe("ma");
    expect(categoriseNews("Kroger and Albertsons merger cleared")).toBe("ma");
  });

  it("legal & regulatory", () => {
    // The real headline from the user's feed screenshot.
    expect(categoriseNews("Uber faces fine of nearly $1B over automated driver suspensions")).toBe("legal");
    expect(categoriseNews("PEGA Investors Have Opportunity to Join Pegasystems Inc. Fraud Investigation")).toBe("legal");
    expect(categoriseNews("FDA issues a complete response letter for the drug")).toBe("legal");
  });

  it("product & launches", () => {
    expect(categoriseNews("Apple unveils the M5 MacBook Pro")).toBe("product");
    expect(categoriseNews("Palantir partners with Anthropic on defence AI")).toBe("product");
    expect(categoriseNews("FDA grants approval for the new therapy")).toBe("product");
  });

  it("capital & dividends", () => {
    // Also from the screenshot.
    expect(categoriseNews("This Company Has Raised Its Dividend for 72 Straight Years")).toBe("capital");
    expect(categoriseNews("Board approves a $10 billion share repurchase")).toBe("capital");
  });

  it("falls back to other", () => {
    expect(categoriseNews("Gold Price Forecast: Breakout Clears 200-Day as Dollar Sinks")).toBe("other");
    expect(categoriseNews("")).toBe("other");
    expect(categoriseNews(null)).toBe("other");
  });

  it("prefers earnings when a headline satisfies several rules", () => {
    // Specificity order matters: this is an earnings story, not capital returns.
    expect(
      categoriseNews("Pfizer beats estimates, raises guidance and announces a buyback"),
    ).toBe("earnings");
  });

  it("uses the summary when the headline alone is vague", () => {
    expect(categoriseNews("Big news for shareholders", "The board declared a special dividend")).toBe("capital");
  });
});

describe("categoriseNews M&A precision", () => {
  it("does not call listicle clickbait an acquisition", () => {
    // 79 of 400 M&A-tagged stories were headlines like these.
    for (const h of [
      "2 Top Growth Stocks to Buy Right Now Without Any Hesitation",
      "The Smartest ETF to Buy With $750 Right Now",
      "1 Unstoppable Stock to Buy Before It Joins Nvidia",
      "Nvidia Stock Is Trading at a Shocking Valuation. Now Is the Perfect Time to Buy",
      "2 Dividend Stocks to Buy and Never Sell",
    ]) expect(categoriseNews(h)).not.toBe("ma");
  });

  it("does not treat 13F holdings boilerplate as a deal", () => {
    expect(categoriseNews("Apple Inc. $AAPL Shares Acquired by Balefire LLC")).not.toBe("ma");
    expect(categoriseNews("AbbVie Inc. Shares Sold by ABN Amro Investment Solutions")).not.toBe("ma");
  });

  it("still catches real transactions", () => {
    expect(categoriseNews("Salesforce agrees to buy Informatica for $8B")).toBe("ma");
    expect(categoriseNews("Curaleaf's Hostile Takeover Bid for Aurora")).toBe("ma");
    expect(categoriseNews("Broadcom acquires VMware")).toBe("ma");
    expect(categoriseNews("Kroger and Albertsons merger cleared")).toBe("ma");
  });
});

describe("categoriseNews M&A is headline-scoped", () => {
  it("ignores deal words that appear only in the summary", () => {
    // Real miss: this was tagged M&A off its body copy alone.
    expect(categoriseNews(
      "Why Tempus AI Skyrocketed This Week",
      "The company discussed its acquisition strategy and merger pipeline.",
    )).not.toBe("ma");
  });
  it("still tags a deal announced in the headline", () => {
    expect(categoriseNews("Broadcom acquires VMware", "Details follow.")).toBe("ma");
  });
  it("other categories keep reading the summary", () => {
    expect(categoriseNews("Big news for holders", "The board declared a special dividend")).toBe("capital");
  });
});
