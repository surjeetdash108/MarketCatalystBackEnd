import { MarketDataService } from "./market-data.service";
import { PolygonService } from "../polygon/polygon.service";
import type { ConfigService } from "@nestjs/config";
import type { FmpService } from "../fmp/fmp.service";
import type { SecEdgarService } from "../sec-edgar/sec-edgar.service";

const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;
const make = (request: jest.Mock) =>
  new MarketDataService(config, { enabled: true, request } as unknown as FmpService, {} as SecEdgarService);

const poly = (symbol: string, date: string, finalPrice: number | null) => ({
  date, symbol, name: symbol, exchange: "XNAS", price: finalPrice != null ? String(finalPrice) : null,
  finalPrice, numberOfShares: null, totalSharesValue: null, status: "history",
});

/**
 * Errors 1–6 (Recent IPOs frozen since Nov 2; LYCA $17 not the $18 it priced
 * at): FMP's ipos-calendar answers a 7-month window with only this week's 10
 * rows and carries no price on priced deals (priceRange null), so the job
 * stored 9 docs a day and Polygon — 77 rows, final_issue_price — was never
 * asked. Measured 2026-11-18.
 */
describe("IPO calendar: Polygon first (final offer prices, the whole window)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("serves Polygon's calendar with the final offer price, without asking FMP", async () => {
    const p = jest.spyOn(PolygonService.prototype, "getIpoCalendar").mockResolvedValue([poly("LYCA", "2026-10-23", 18)]);
    const request = jest.fn();
    const rows = await make(request).getIpoCalendar("2026-07-21", "2027-02-16");
    expect(p).toHaveBeenCalledWith("2026-07-21", "2027-02-16");
    expect(rows).toEqual([expect.objectContaining({ symbol: "LYCA", finalPrice: 18 })]);
    expect(request).not.toHaveBeenCalled();
  });

  it("falls back to FMP month by month when Polygon fails (FMP truncates wide windows)", async () => {
    jest.spyOn(PolygonService.prototype, "getIpoCalendar").mockRejectedValue(new Error("503"));
    const request = jest.fn((path: string) =>
      Promise.resolve(path.includes("from=2026-10-01") ? [{ symbol: "LYCA", date: "2026-10-23", company: "Lycia", actions: "Priced", priceRange: null }] : []),
    );
    const rows = await make(request).getIpoCalendar("2026-09-15", "2026-11-10");
    const asked = request.mock.calls.map((c) => String(c[0]));
    expect(asked).toEqual([
      "ipos-calendar?from=2026-09-15&to=2026-09-30",
      "ipos-calendar?from=2026-10-01&to=2026-10-31",
      "ipos-calendar?from=2026-11-01&to=2026-11-10",
    ]);
    expect(rows.map((r) => r.symbol)).toEqual(["LYCA"]);
  });
});

