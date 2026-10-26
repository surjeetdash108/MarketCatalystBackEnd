import { MarketDataService } from "./market-data.service";
import { PolygonService } from "../polygon/polygon.service";
import { classifyFromSic } from "../../common/sic-tv.util";
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

  describe("peers (FMP when it has enough US names, else the longer list)", () => {
    const peers = (...syms: string[]) => syms.map((symbol) => ({ symbol }));

    it("uses FMP when it has 3+ US peers, without asking Polygon", async () => {
      const poly = jest.spyOn(PolygonService.prototype, "getRelatedCompanies");
      const svc = make(jest.fn().mockResolvedValue(peers("MSFT", "GOOGL", "BRK-B", "SAP.DE", "AAPL")));
      await expect(svc.getRelatedCompanies("AAPL")).resolves.toEqual(["MSFT", "GOOGL", "BRK.B"]);
      expect(poly).not.toHaveBeenCalled();
    });

    it("prefers Polygon's longer list when FMP's US list is thin (AAPL → only SONY)", async () => {
      jest.spyOn(PolygonService.prototype, "getRelatedCompanies").mockResolvedValue(["MSFT", "AMZN", "GOOGL", "NVDA"]);
      const svc = make(jest.fn().mockResolvedValue(peers("002241.SZ", "PCRFF", "SONY", "SSNLF", "XIACF")));
      await expect(svc.getRelatedCompanies("AAPL")).resolves.toEqual(["MSFT", "AMZN", "GOOGL", "NVDA"]);
    });

    it("keeps FMP's short list when Polygon has none", async () => {
      jest.spyOn(PolygonService.prototype, "getRelatedCompanies").mockResolvedValue([]);
      await expect(make(jest.fn().mockResolvedValue(peers("ELMD"))).getRelatedCompanies("GAUZ")).resolves.toEqual(["ELMD"]);
    });
  });

  describe("ticker universe (FMP primary, Polygon gap-fill)", () => {
    const polygonRef = (ticker: string, extra: Record<string, unknown> = {}) => ({
      ticker, name: `${ticker} (polygon)`, market: "stocks", locale: "us", active: true,
      type: "CS", primary_exchange: "XNYS", cik: "0001", composite_figi: "BBG", ...extra,
    });
    const screener = (rows: Record<string, unknown>[]) =>
      jest.fn((path: string) => Promise.resolve(path.includes("exchange=NASDAQ") ? rows : []));

    it("lets FMP win the name, keeps Polygon's venue/type/FIGI, and adds Polygon-only symbols", async () => {
      jest.spyOn(PolygonService.prototype, "getAllTickers").mockResolvedValue([
        polygonRef("AAPL"), polygonRef("BRK.B"), polygonRef("ABRpD", { type: "PFD" }),
      ]);
      const request = screener([
        { symbol: "AAPL", companyName: "Apple Inc.", exchange: "NASDAQ Global Select", isEtf: false },
        { symbol: "BRK-B", companyName: "Berkshire Hathaway Inc.", exchange: "New York Stock Exchange" },
        { symbol: "QQQ", companyName: "Invesco QQQ Trust", exchange: "NASDAQ Global Market", isEtf: true },
        { symbol: "BBBYW", companyName: "warrant", exchange: "NASDAQ Capital Market" },
        { symbol: "MER-PK", companyName: "Merrill pref", exchange: "New York Stock Exchange" },
        { symbol: "600000.SS", companyName: "foreign", exchange: "SHH" },
      ]);
      const rows = await make(request).getAllTickers(true);
      const by = new Map(rows.map((r) => [r.ticker, r]));
      expect(request.mock.calls.map((c) => c[0])).toEqual(
        ["NASDAQ", "NYSE", "AMEX", "CBOE"].map((ex) => expect.stringContaining(`company-screener?exchange=${ex}&isActivelyTrading=true&isFund=false`)),
      );
      // Venue stays Polygon's: FMP mislabels NYSE American listings as Arca.
      expect(by.get("AAPL")).toMatchObject({ name: "Apple Inc.", primary_exchange: "XNYS", type: "CS", cik: "0001", composite_figi: "BBG" });
      expect(by.get("BRK.B")?.name).toBe("Berkshire Hathaway Inc.");
      expect(by.get("QQQ")).toMatchObject({ type: "ETF", primary_exchange: "XNAS", active: true });
      expect(by.get("ABRpD")?.type).toBe("PFD"); // Polygon-only symbol kept
      expect(by.has("MER.PK")).toBe(false); // FMP spelling of a Polygon share class
      expect(by.has("BBBYW")).toBe(false); // 5-letter FMP-only: warrant/right/fund
      expect(by.has("600000.SS")).toBe(false);
      expect(rows).toHaveLength(4);
    });

    it("serves FMP alone when Polygon fails, and Polygon alone when FMP fails", async () => {
      const poly = jest.spyOn(PolygonService.prototype, "getAllTickers").mockRejectedValueOnce(new Error("429"));
      const fmpRows = [{ symbol: "MER-PK", companyName: "Merrill pref", exchange: "New York Stock Exchange" }];
      await expect(make(screener(fmpRows)).getAllTickers(true)).resolves.toEqual([
        expect.objectContaining({ ticker: "MER.PK", type: "CS", primary_exchange: "XNYS" }),
      ]);

      poly.mockResolvedValueOnce([polygonRef("AAPL")]);
      await expect(make(jest.fn().mockRejectedValue(new Error("503"))).getAllTickers(true)).resolves.toEqual([polygonRef("AAPL")]);
    });

    it("throws when both vendors fail, and refuses a screener answer at the row cap", async () => {
      jest.spyOn(PolygonService.prototype, "getAllTickers").mockRejectedValue(new Error("polygon down"));
      await expect(make(jest.fn().mockRejectedValue(new Error("fmp down"))).getAllTickers(true)).rejects.toThrow("polygon down");
      const capped = jest.fn().mockResolvedValue(Array.from({ length: 10_000 }, (_, i) => ({ symbol: `A${i}`, companyName: "x" })));
      await expect(make(capped).getAllTickers(true)).rejects.toThrow("polygon down");
    });

    it("leaves inactive listings to Polygon", async () => {
      const poly = jest.spyOn(PolygonService.prototype, "getAllTickers").mockResolvedValue([]);
      const request = jest.fn();
      await make(request).getAllTickers(false);
      expect(request).not.toHaveBeenCalled();
      expect(poly).toHaveBeenCalledWith(false);
    });
  });

  describe("delistings (FMP primary, Polygon backup)", () => {
    const pages = (...p: Record<string, unknown>[][]) => {
      const fn = jest.fn();
      for (const page of p) fn.mockResolvedValueOnce(page);
      return fn.mockResolvedValue([]);
    };

    it("answers from FMP's US delisting records, newest date wins, without calling Polygon", async () => {
      const poly = jest.spyOn(PolygonService.prototype, "getDelisting");
      const request = pages(
        [
          { symbol: "AACB", exchange: "NASDAQ", delistedDate: "2026-08-20" },
          { symbol: "BRK-B", exchange: "NYSE", delistedDate: "2026-07-01" },
          { symbol: "NB2.F", exchange: "FSX", delistedDate: "2026-08-01" },
        ],
        [{ symbol: "AACB", exchange: "NASDAQ", delistedDate: "2019-01-02" }],
      );
      const svc = make(request);
      await expect(svc.getDelisting("AACB")).resolves.toEqual({ delistedAt: "2026-08-20" });
      await expect(svc.getDelisting("BRK.B")).resolves.toEqual({ delistedAt: "2026-07-01" });
      expect(poly).not.toHaveBeenCalled();
      // One index build (2 pages + the empty terminator) serves every lookup.
      expect(request).toHaveBeenCalledTimes(3);
    });

    it("ignores foreign and future-dated rows, and asks Polygon when FMP has no record", async () => {
      const poly = jest.spyOn(PolygonService.prototype, "getDelisting").mockResolvedValue({ delistedAt: "2026-01-05" });
      const svc = make(pages([
        { symbol: "UUU", exchange: "AMEX", delistedDate: "2999-01-01" },
        { symbol: "VOD", exchange: "LSE", delistedDate: "2026-01-01" },
      ]));
      await expect(svc.getDelisting("UUU")).resolves.toEqual({ delistedAt: "2026-01-05" });
      await expect(svc.getDelisting("VOD")).resolves.toEqual({ delistedAt: "2026-01-05" });
      expect(poly).toHaveBeenCalledTimes(2);
    });

    it("falls back to Polygon when FMP's delisting feed errors", async () => {
      const poly = jest.spyOn(PolygonService.prototype, "getDelisting").mockResolvedValue(null);
      await expect(make(jest.fn().mockRejectedValue(new Error("503"))).getDelisting("AACB")).resolves.toBeNull();
      expect(poly).toHaveBeenCalledWith("AACB");
    });
  });
});

describe("MarketDataService.getTickerDetails — classification when SEC is unavailable", () => {
  // Real FMP profile + Polygon ticker details for CAT (saved 2026-10-26).
  const fx = JSON.parse(
    require("fs").readFileSync(require("path").join(__dirname, "fixtures/cat-profile-details.json"), "utf-8"),
  );
  afterEach(() => jest.restoreAllMocks());

  it("takes Polygon's SIC when SEC returns none, so CAT still classifies", async () => {
    jest.spyOn(PolygonService.prototype, "getTickerDetails").mockResolvedValue(fx.polygonDetails);
    const fmp = { enabled: true, request: jest.fn().mockResolvedValue(fx.fmpProfile), requestText: jest.fn() } as unknown as FmpService;
    const sec = { getSicByTicker: jest.fn().mockResolvedValue(null) } as unknown as SecEdgarService;
    const d = await new MarketDataService(config, fmp, sec).getTickerDetails("CAT");
    expect(String(d.sic_code)).toBe("3531");
    expect(classifyFromSic(d.sic_code, "CAT")?.sector).toBe("Producer Manufacturing");
  });

  it("SEC's SIC still wins when present", async () => {
    jest.spyOn(PolygonService.prototype, "getTickerDetails").mockResolvedValue(fx.polygonDetails);
    const fmp = { enabled: true, request: jest.fn().mockResolvedValue(fx.fmpProfile), requestText: jest.fn() } as unknown as FmpService;
    const sec = { getSicByTicker: jest.fn().mockResolvedValue("3523") } as unknown as SecEdgarService;
    const d = await new MarketDataService(config, fmp, sec).getTickerDetails("CAT");
    expect(String(d.sic_code)).toBe("3523");
  });
});
