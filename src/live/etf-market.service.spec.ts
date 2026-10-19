import type { ConfigService } from "@nestjs/config";
import { fetchJson } from "../common/http.util";
import type { FmpService } from "../vendors/fmp/fmp.service";
import { ETFClassifier } from "./etf-classifier";
import { EtfMarketService } from "./etf-market.service";

jest.mock("../common/http.util", () => ({ fetchJson: jest.fn() }));
const polygonHttp = fetchJson as jest.MockedFunction<typeof fetchJson>;

const config = {
  get: (k: string, d?: unknown) => (k === "POLYGON_API_KEY" ? "pk" : d),
} as unknown as ConfigService;

/** Polygon reference + snapshot endpoints, answered from fixed tables. */
function mockPolygon(opts: {
  refs?: Array<Record<string, unknown>>;
  snapshot?: Array<Record<string, unknown>>;
  fail?: boolean;
}) {
  polygonHttp.mockImplementation(async (url: string) => {
    if (opts.fail) throw new Error("polygon down");
    if (url.includes("/v3/reference/tickers?")) {
      const type = /type=(\w+)/.exec(url)?.[1];
      return { results: (opts.refs ?? []).filter((r) => r.type === type) };
    }
    if (url.includes("/v2/snapshot/")) return { tickers: opts.snapshot ?? [] };
    if (url.includes("/v3/reference/tickers/")) return { results: { share_class_shares_outstanding: 1_000 } };
    throw new Error(`unexpected ${url}`);
  });
}

function make(request: jest.Mock | null) {
  const fmp = request
    ? ({ enabled: true, request } as unknown as FmpService)
    : undefined;
  return new EtfMarketService(config, new ETFClassifier(), undefined, fmp);
}

const fmpRequest = (
  screener: Array<Record<string, unknown>>,
  quotes: Array<Record<string, unknown>>,
  aum: Record<string, number> = {},
) =>
  jest.fn(async (path: string) => {
    if (path.startsWith("company-screener")) return path.includes("exchange=AMEX") ? screener : [];
    if (path.startsWith("batch-etf-quotes")) return quotes;
    if (path.startsWith("etf/info")) {
      const sym = /symbol=([A-Z]+)/.exec(path)?.[1] ?? "";
      return sym in aum ? [{ symbol: sym, assetsUnderManagement: aum[sym] }] : [];
    }
    throw new Error(`unexpected ${path}`);
  });

const fund = (res: Awaited<ReturnType<EtfMarketService["getCategorizedEtfs"]>>, symbol: string) =>
  res.largest.find((f) => f.symbol === symbol);

describe("EtfMarketService (FMP primary, Polygon backup)", () => {
  beforeEach(() => polygonHttp.mockReset());

  it("prices and sizes FMP-listed funds from FMP, keeps Polygon's ETV type, and adds Polygon-only funds", async () => {
    mockPolygon({
      refs: [
        { ticker: "GLD", name: "SPDR Gold Trust (polygon)", type: "ETV", active: true },
        { ticker: "SPY", name: "SPDR S&P 500 (polygon)", type: "ETF", active: true },
        { ticker: "ZZZ", name: "Polygon Only Equity ETF", type: "ETF", active: true },
      ],
      snapshot: [
        { ticker: "SPY", day: { c: 1, v: 1 }, todaysChange: 9, todaysChangePerc: 9 },
        { ticker: "ZZZ", day: { c: 20, v: 500 }, todaysChange: 1, todaysChangePerc: 5.26 },
      ],
    });
    const request = fmpRequest(
      [
        // The screener's marketCap is ignored — unreliable for ETFs.
        { symbol: "SPY", companyName: "SPDR S&P 500 ETF Trust", marketCap: 1, isEtf: true },
        { symbol: "GLD", companyName: "SPDR Gold Shares", marketCap: 1, isEtf: true },
      ],
      [
        { symbol: "SPY", price: 700, change: 7, volume: 1_000.6 },
        { symbol: "GLD", price: 380, change: -3.8, volume: 50 },
        { symbol: "SPY.L", price: 1, change: 0, volume: 1 },
      ],
      { SPY: 700e9, GLD: 100e9 },
    );
    const res = await make(request).getCategorizedEtfs();

    expect(fund(res, "SPY")).toMatchObject({
      name: "SPDR S&P 500 ETF Trust", price: 700, change: 7, changePercent: 1.0101, volume: 1001, aum: 700e9,
    });
    // ETV from Polygon keeps a physical gold trust out of Equity.
    expect(fund(res, "GLD")?.categories).toEqual(expect.arrayContaining(["gold", "commodities"]));
    expect(fund(res, "GLD")?.categories).not.toContain("equity");
    // Polygon fills the fund FMP does not list, priced from Polygon's snapshot.
    expect(fund(res, "ZZZ")).toMatchObject({ price: 20, changePercent: 5.26 });
    expect(res.source).toBe("fmp+massive-polygon");
    // No Polygon share-count lookups for funds FMP already sized.
    const detailCalls = polygonHttp.mock.calls.filter(([u]) => /\/v3\/reference\/tickers\/[A-Z]+\?/.test(u));
    expect(detailCalls.map(([u]) => /tickers\/([A-Z]+)\?/.exec(u)?.[1])).toEqual(["ZZZ"]);
  });

  it("serves FMP alone when Polygon is down", async () => {
    mockPolygon({ fail: true });
    const request = fmpRequest(
      [{ symbol: "SPY", companyName: "SPDR S&P 500 ETF Trust" }],
      [{ symbol: "SPY", price: 700, change: 7, volume: 10 }],
      { SPY: 700e9 },
    );
    const res = await make(request).getCategorizedEtfs();
    expect(fund(res, "SPY")).toMatchObject({ price: 700, aum: 700e9 });
    expect(res.source).toBe("fmp");
  });

  it("falls back to Polygon entirely when FMP fails or has no key", async () => {
    const polygon = {
      refs: [{ ticker: "SPY", name: "SPDR S&P 500", type: "ETF", active: true }],
      snapshot: [{ ticker: "SPY", day: { c: 700, v: 10 }, todaysChange: 7, todaysChangePerc: 1.01 }],
    };
    mockPolygon(polygon);
    const failing = jest.fn().mockRejectedValue(new Error("fmp 503"));
    const viaFailure = await make(failing).getCategorizedEtfs();
    expect(fund(viaFailure, "SPY")).toMatchObject({ price: 700, aum: 700 * 1_000 });
    expect(viaFailure.source).toBe("massive-polygon");

    mockPolygon(polygon);
    const noKey = await make(null).getCategorizedEtfs();
    expect(fund(noKey, "SPY")?.price).toBe(700);
    expect(noKey.source).toBe("massive-polygon");
  });
});
