import { TradingViewNewsAdapter } from "./tradingview-news.adapter";

describe("TradingViewNewsAdapter", () => {
  it("is inert and non-fatal when no feed URL is configured", async () => {
    const a = new TradingViewNewsAdapter(null);
    expect(a.enabled).toBe(false);
    const res = await a.fetchMarketNews("2026-08-01", "2026-08-23");
    // §12: a provider that cannot run must not fail the ingestion cycle.
    expect(res.data).toEqual([]);
    expect(res.warnings[0].message).toMatch(/LICENSED feed/);
  });

  it("reports the adapter name for job logging", () => {
    expect(new TradingViewNewsAdapter(null).sourceName).toBe("tradingview");
  });

  it("is enabled once a feed URL is supplied", () => {
    expect(new TradingViewNewsAdapter("https://feed.example/news").enabled).toBe(true);
  });
});
