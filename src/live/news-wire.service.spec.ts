import { NewsWireService } from "./news-wire.service";

const news = (symbol: string | null, title: string, publishedDate: string, url = `https://x.test/${encodeURIComponent(title)}`) =>
  ({ symbol, title, publishedDate, url, site: "reuters.com", text: "body" });

/** FMP stub answering each wire endpoint from `feeds` (path prefix → rows or a function of the call count). */
function fmpStub(feeds: Record<string, unknown[] | ((n: number) => unknown[] | Promise<unknown[]>)>) {
  const calls: Record<string, number> = {};
  const request = jest.fn(async (path: string) => {
    const key = Object.keys(feeds).find((k) => path.startsWith(k));
    if (!key) return [];
    calls[key] = (calls[key] ?? 0) + 1;
    const f = feeds[key];
    return typeof f === "function" ? f(calls[key]) : f;
  });
  return { fmp: { enabled: true, request } as never, request, calls };
}

describe("NewsWireService", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(Date.parse("2026-10-19T22:20:00Z")));
  afterEach(() => jest.useRealTimers());

  it("shapes stock news like news docs, polls each feed at its own pace, and serves new arrivals by seen-time", async () => {
    const { fmp, calls } = fmpStub({
      "news/stock-latest": (n) => n === 1
        ? [news("CCK", "Crown Holdings (CCK) Beats Q3 Earnings and Revenue Estimates", "2026-10-19 18:15:53"), news(null, "No ticker", "2026-10-19 18:16:00")]
        : [news("DUOL", "Duolingo lawsuit", "2026-10-19 18:18:00")],
      // Late 8-K: accepted EARLIER than the stories already shown, still delivered as new.
      "sec-filings-8k": (n) => n === 1 ? [] : [
        { symbol: "SXIW", acceptedDate: "2026-10-19 17:27:39", formType: "8-K", finalLink: "https://sec.test/sxi", hasFinancials: false }, // warrant line of the same filing
        { symbol: "SXI", acceptedDate: "2026-10-19 17:27:39", formType: "8-K", finalLink: "https://sec.test/sxi", hasFinancials: false },
      ],
    });
    const svc = new NewsWireService(fmp);

    const first = await svc.latest();
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      ticker: "CCK", vendor: "fmp", tag: "earnings", wireKind: "news", source: "reuters.com",
      publishedAt: "2026-10-19T22:15:53.000Z", // FMP's ET timestamp → UTC
    });
    expect(first.items[0].id).toMatch(/^CCK_fmp_/);

    await svc.latest(String(first.now)); // within 15s: served from memory
    expect(calls["news/stock-latest"]).toBe(1);

    jest.setSystemTime(Date.parse("2026-10-19T22:20:16Z")); // stock news due, 8-Ks (30s) not yet
    const second = await svc.latest(String(first.now));
    // CCK was seen in the same ms as the first answer, so it may be resent once; never dropped.
    expect(second.items.map((d) => d.ticker)).toEqual(["DUOL", "CCK"]);
    expect(calls["sec-filings-8k"]).toBe(1);

    jest.setSystemTime(Date.parse("2026-10-19T22:20:31Z"));
    const third = await svc.latest(String(second.now));
    expect(third.items.find((d) => d.ticker === "SXI")).toMatchObject({ wireKind: "filing", publishedAt: "2026-10-19T21:27:39.000Z" });
    expect(third.items.some((d) => d.ticker === "CCK")).toBe(false); // older arrivals are not resent
    expect(third.items.some((d) => d.ticker === "SXIW")).toBe(false); // one row per filing, under the common stock
  });

  it("joins a grade change and its price target into one analyst row", async () => {
    const url = "https://thefly.test/crwv";
    const { fmp } = fmpStub({
      "grades-latest-news": [{ symbol: "CRWV", publishedDate: "2026-10-19T20:51:41.000Z", newsURL: url, newsTitle: "CoreWeave price target lowered to $117 from $169 at BNP Paribas", newsPublisher: "TheFly", gradingCompany: "Exane BNP Paribas", previousGrade: "Outperform", newGrade: "Outperform", action: "hold" }],
      "price-target-latest-news": [{ symbol: "CRWV", publishedDate: "2026-10-19T20:51:41.000Z", newsURL: url, newsTitle: "CoreWeave price target lowered to $117 from $169 at BNP Paribas", newsPublisher: "TheFly", analystName: "Jane Doe", analystCompany: "Exane BNP Paribas", priceTarget: 117, priceWhenPosted: 139.4 }],
    });
    const { items } = await new NewsWireService(fmp).latest();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      ticker: "CRWV", wireKind: "analyst", tag: "analyst", source: "TheFly",
      summary: "Exane BNP Paribas: Outperform (hold) · PT $117 (Jane Doe) · stock $139 when posted",
      publishedAt: "2026-10-19T20:51:41.000Z",
    });
  });

  it("keeps a story once when two feeds carry it, and macro news without a ticker", async () => {
    const { fmp } = fmpStub({
      "news/stock-latest": [news("BBW", "Build-A-Bear Investor News", "2026-10-19 18:18:00", "https://a.test/1")],
      "news/press-releases-latest": [news("BBW", "Build-A-Bear Investor News", "2026-10-19 18:18:00", "https://b.test/2")],
      "news/general-latest": [news(null, "Big Tech Earnings Could Validate AI", "2026-10-19 17:50:33")],
    });
    const { items } = await new NewsWireService(fmp).latest();
    expect(items.filter((d) => d.ticker === "BBW")).toHaveLength(1);
    expect(items.find((d) => d.wireKind === "macro")).toMatchObject({ ticker: "", category: "macro", id: expect.stringMatching(/^wire_fmp_/) });
  });

  it("keeps serving what it has when a feed fails", async () => {
    const { fmp } = fmpStub({
      "news/stock-latest": (n) => (n === 1 ? [news("CCK", "Crown", "2026-10-19 18:15:53")] : Promise.reject(new Error("503"))),
    });
    const svc = new NewsWireService(fmp);
    await svc.latest();
    jest.setSystemTime(Date.parse("2026-10-19T22:20:20Z"));
    await expect(svc.latest()).resolves.toMatchObject({ items: [expect.objectContaining({ ticker: "CCK" })] });
  });
});
