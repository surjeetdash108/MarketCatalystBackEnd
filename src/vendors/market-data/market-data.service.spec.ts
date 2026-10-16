import { MarketDataService } from "./market-data.service";
import { PolygonService } from "../polygon/polygon.service";
import type { ConfigService } from "@nestjs/config";
import type { FmpService } from "../fmp/fmp.service";
import type { SecEdgarService } from "../sec-edgar/sec-edgar.service";

const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;

function make(request: jest.Mock, extra: Partial<Record<string, unknown>> = {}) {
  const fmp = {
    enabled: true,
    request,
    requestText: jest.fn(),
    getExtendedTrades: jest.fn().mockResolvedValue([]),
    ...extra,
  } as unknown as FmpService;
  const sec = { getSicByTicker: jest.fn().mockResolvedValue("3571") } as unknown as SecEdgarService;
  return new MarketDataService(config, fmp, sec);
}

describe("MarketDataService (FMP primary, Polygon fallback)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("serves daily bars from FMP in Polygon's shape, oldest first", async () => {
    const poly = jest.spyOn(PolygonService.prototype, "getAggsRange");
    const svc = make(jest.fn().mockResolvedValue([
      { date: "2026-10-16", open: 2, high: 3, low: 1, close: 2.5, volume: 10.6, vwap: 2.2 },
      { date: "2026-10-15", open: 1, high: 2, low: 0.5, close: 1.5, volume: 5 },
    ]));
    const bars = await svc.getAggsRange("AAPL", "2026-10-15", "2026-10-16");
    expect(poly).not.toHaveBeenCalled();
    expect(bars.map((b) => b.c)).toEqual([1.5, 2.5]);
    expect(bars[1]).toMatchObject({ T: "AAPL", o: 2, h: 3, l: 1, v: 11, vw: 2.2 });
    expect(new Date(bars[0].t).toISOString()).toBe("2026-10-15T04:00:00.000Z"); // ET midnight
  });

  it("falls back to Polygon when FMP errors or answers empty", async () => {
    const poly = jest.spyOn(PolygonService.prototype, "getAggsRange").mockResolvedValue([{ T: "X", t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
    await expect(make(jest.fn().mockRejectedValue(new Error("503"))).getAggsRange("X", "a", "b")).resolves.toHaveLength(1);
    await expect(make(jest.fn().mockResolvedValue([])).getAggsRange("X", "a", "b")).resolves.toHaveLength(1);
    expect(poly).toHaveBeenCalledTimes(2);
  });

  it("routes Polygon-only tickers and unsupported sizes straight to Polygon", async () => {
    const poly = jest.spyOn(PolygonService.prototype, "getAggsRange").mockResolvedValue([]);
    const request = jest.fn();
    const svc = make(request);
    await svc.getAggsRange("I:SPX", "a", "b");
    await svc.getAggsRange("AAPL", "a", "b", "minute", 3);
    await svc.getAggsRange("AAPL", "a", "b", "week", 1);
    expect(request).not.toHaveBeenCalled();
    expect(poly).toHaveBeenCalledTimes(3);
  });

  it("pages intraday history backwards past FMP's per-call cap and dedupes the overlap", async () => {
    const request = jest.fn()
      // first page: newest, cut mid-day on the 15th
      .mockResolvedValueOnce([
        { date: "2026-10-16 09:35:00", open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { date: "2026-10-16 09:30:00", open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { date: "2026-10-15 15:55:00", open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ])
      // second page re-reads the 15th in full (overlap) and reaches `from`
      .mockResolvedValueOnce([
        { date: "2026-10-15 15:55:00", open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { date: "2026-10-15 09:30:00", open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { date: "2026-10-14 09:30:00", open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ]);
    const bars = await make(request).getAggsRange("AAPL", "2026-10-14", "2026-10-16", "minute", 5);
    expect(request.mock.calls[0][0]).toContain("historical-chart/5min?symbol=AAPL&from=2026-10-14&to=2026-10-16&extended=true");
    expect(request.mock.calls[1][0]).toContain("to=2026-10-15");
    expect(bars).toHaveLength(5);
    expect(bars.map((b) => b.t)).toEqual([...bars.map((b) => b.t)].sort((a, b) => a - b));
  });

  it("maps FMP's class-share symbol format both ways", async () => {
    const request = jest.fn().mockResolvedValue([{ date: "2026-10-16", open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    const [bar] = await make(request).getAggsRange("BRK.B", "2026-10-16", "2026-10-16");
    expect(request.mock.calls[0][0]).toContain("symbol=BRK-B");
    expect(bar.T).toBe("BRK.B");
  });

  it("fills snapshot rows FMP cannot price from Polygon, keeping request order", async () => {
    jest.spyOn(PolygonService.prototype, "getUniversalSnapshot").mockResolvedValue([
      { ticker: "I:SPX", price: 6000 } as never,
      { ticker: "ZZZZ", price: 3 } as never,
    ]);
    const svc = make(jest.fn().mockResolvedValue([
      { symbol: "AAPL", name: "Apple", price: 344, change: 2, changePercentage: 0.6, previousClose: 342, open: 343, dayHigh: 345, dayLow: 341, volume: 9 },
    ]));
    const snap = await svc.getUniversalSnapshot(["AAPL", "I:SPX", "ZZZZ"]);
    expect(snap.map((s) => s.ticker)).toEqual(["AAPL", "I:SPX", "ZZZZ"]);
    expect(snap[0]).toMatchObject({ name: "Apple", price: 344, changePercent: 0.6, previousClose: 342, high: 345 });
  });

  it("maps FMP profile onto Polygon ticker-details fields with SEC SIC", async () => {
    const d = await make(jest.fn().mockResolvedValue([
      { companyName: "Apple Inc.", marketCap: 5000, price: 10, exchange: "NASDAQ", description: "x", website: "w", isEtf: false },
    ])).getTickerDetails("AAPL");
    expect(d).toMatchObject({
      name: "Apple Inc.", market_cap: 5000, weighted_shares_outstanding: 500,
      primary_exchange: "XNAS", sic_code: "3571", type: "CS", homepage_url: "w",
    });
  });

  it("treats an empty split history as a valid answer, not a failure", async () => {
    const poly = jest.spyOn(PolygonService.prototype, "getSplits");
    await expect(make(jest.fn().mockResolvedValue([])).getSplits("MSFT")).resolves.toEqual([]);
    expect(poly).not.toHaveBeenCalled();
  });

  it("serves Polygon only when the FMP key is absent", async () => {
    const poly = jest.spyOn(PolygonService.prototype, "getTreasuryYields").mockResolvedValue([]);
    const request = jest.fn();
    await make(request, { enabled: false }).getTreasuryYields();
    expect(request).not.toHaveBeenCalled();
    expect(poly).toHaveBeenCalled();
  });
});
