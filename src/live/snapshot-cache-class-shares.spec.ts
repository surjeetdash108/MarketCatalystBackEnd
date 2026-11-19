import { SnapshotCacheService } from "./snapshot-cache.service";

// Nov 19 row 2 (BRK.B −3.07%): the live cache sent "BRK.B" to FMP, which only
// knows "BRK-B", so BRK.B got no FMP quote and fell back to Polygon, whose
// snapshot previous_close was the Nov 17 close.
describe("live quotes ask FMP for class shares in its spelling", () => {
  it("BRK.B is requested as BRK-B and comes back as BRK.B", async () => {
    const config = {
      get: (k: string, d?: unknown) =>
        (
          ({
            LIVE_QUOTE_SOURCE: "fmp",
            LIVE_QUOTE_FALLBACK_SOURCE: "none",
          }) as Record<string, unknown>
        )[k] ?? d,
    } as never;
    const getQuotes = jest.fn((syms: string[]) =>
      Promise.resolve(
        syms.includes("BRK-B")
          ? [
              {
                symbol: "BRK-B",
                price: 568.8,
                previousClose: 574.62,
                changePercentage: -1.01,
                change: -5.82,
                dayLow: 567.93,
                dayHigh: 573.13,
                open: 573,
                volume: 1,
                timestamp: 1,
                marketCap: 1,
                name: "Berkshire",
              },
            ]
          : [],
      ),
    );
    const fmp = {
      enabled: true,
      batchQuoteSupported: true,
      getQuotes,
      getExtendedTrades: jest.fn().mockResolvedValue([]),
    };
    const svc = new SnapshotCacheService(config, fmp as never);
    const res = await svc.get(["BRK.B"]);
    svc.onModuleDestroy();
    expect(getQuotes.mock.calls[0][0]).toEqual(["BRK-B"]);
    expect(res.quotes.map((q) => [q.ticker, q.previousClose])).toEqual([
      ["BRK.B", 574.62],
    ]);
  });
});
