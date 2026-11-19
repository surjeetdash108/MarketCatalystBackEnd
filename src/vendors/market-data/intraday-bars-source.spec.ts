import { MarketDataService } from "./market-data.service";
import { PolygonService } from "../polygon/polygon.service";
import type { ConfigService } from "@nestjs/config";
import type { FmpService } from "../fmp/fmp.service";
import type { SecEdgarService } from "../sec-edgar/sec-edgar.service";

const config = {
  get: (_k: string, d?: unknown) => d,
} as unknown as ConfigService;
const make = (request: jest.Mock) =>
  new MarketDataService(
    config,
    { enabled: true, request } as unknown as FmpService,
    {} as SecEdgarService,
  );

/**
 * Nov 18/19 workbooks (FCX/SCCO/B opening range = the open): FMP's 5-minute
 * bars leave out the opening auction and first prints (FCX Nov 18 09:30: FMP
 * o 51.94 h 52.14; Polygon o 52.18 h 52.63 — the official open and the real
 * first-bar high). Intraday bars take Polygon's prices first, like Money
 * Flow's bars; FMP only when Polygon has none. Daily bars stay FMP-first.
 */
describe("intraday bars: Polygon first (opening auction included)", () => {
  afterEach(() => jest.restoreAllMocks());
  it("5-minute bars come from Polygon without asking FMP", async () => {
    const poly = jest
      .spyOn(PolygonService.prototype, "getAggsRange")
      .mockResolvedValue([
        { T: "FCX", t: 1, o: 52.18, h: 52.63, l: 51.44, c: 51.45, v: 1 },
      ]);
    const request = jest.fn();
    const bars = await make(request).getAggsRange(
      "FCX",
      "2026-11-18",
      "2026-11-18",
      "minute",
      5,
    );
    expect(poly).toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(bars[0]).toMatchObject({ o: 52.18, h: 52.63 });
  });
  it("FMP fills in when Polygon returns nothing", async () => {
    jest.spyOn(PolygonService.prototype, "getAggsRange").mockResolvedValue([]);
    const request = jest.fn().mockResolvedValue([
      {
        date: "2026-11-18 09:30:00",
        open: 51.94,
        high: 52.14,
        low: 51.45,
        close: 51.5,
        volume: 10,
      },
    ]);
    const bars = await make(request).getAggsRange(
      "FCX",
      "2026-11-18",
      "2026-11-18",
      "minute",
      5,
    );
    expect(bars).toHaveLength(1);
  });
  it("daily bars stay FMP-first", async () => {
    const poly = jest.spyOn(PolygonService.prototype, "getAggsRange");
    await make(
      jest
        .fn()
        .mockResolvedValue([
          { date: "2026-11-18", open: 1, high: 2, low: 1, close: 2, volume: 1 },
        ]),
    ).getAggsRange("FCX", "2026-11-18", "2026-11-18");
    expect(poly).not.toHaveBeenCalled();
  });
});
