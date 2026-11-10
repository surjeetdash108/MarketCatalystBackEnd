import * as fs from "fs";
import * as path from "path";
import { SnapshotCacheService } from "./snapshot-cache.service";

/**
 * Header-search dropdown, E2E Oct 26: 10 tickers showed no price (KR, JJSF,
 * MTDR, NGS, PNRG, EPM, GE, VFC, DGII, PRGS) and 18 showed a price minutes old
 * (MAT 15.78 / −3.84% when the stock header read 15.88 / −3.22%). Real FMP
 * batch-quote rows (saved after the Oct 26 close) stand in for the vendor.
 */
jest.setTimeout(8000);
describe("SnapshotCacheService.get", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/after-close-quotes.json"), "utf-8"));
  const rowsFor = (syms: string[]) => fx.quotes.filter((q: { symbol: string }) => syms.includes(q.symbol));
  const config = { get: (k: string, d?: unknown) => ({ LIVE_QUOTE_SOURCE: "fmp", LIVE_QUOTE_FALLBACK_SOURCE: "none" } as Record<string, unknown>)[k] ?? d } as never;

  function make(getQuotes: jest.Mock) {
    const fmp = { enabled: true, batchQuoteSupported: true, getQuotes, getExtendedTrades: jest.fn().mockResolvedValue([]) };
    return new SnapshotCacheService(config, fmp as never);
  }
  afterEach(() => jest.useRealTimers());

  it("two first-time tickers requested while a refresh runs both come back priced", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const getQuotes = jest.fn(async (syms: string[]) => {
      if (syms.includes("PEP")) await gate;
      return rowsFor(syms);
    });
    const svc = make(getQuotes);
    const first = svc.get(["PEP"]);
    const kr = svc.get(["KR"]);
    const cat = svc.get(["CAT"]);
    release();
    await first;
    const [a, b] = await Promise.all([kr, cat]);
    expect(a.quotes.map((q) => q.ticker)).toEqual(["KR"]);
    expect(b.quotes.map((q) => q.ticker)).toEqual(["CAT"]);
    svc.onModuleDestroy();
  });

  it("during the session an entry older than one refresh interval (10 s) is re-fetched on read", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    jest.setSystemTime(new Date("2026-10-26T18:45:00Z")); // 14:45 ET, market open
    const getQuotes = jest.fn(async (syms: string[]) => rowsFor(syms));
    const svc = make(getQuotes);
    await svc.get(["CAT"]);
    expect(getQuotes).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date("2026-10-26T18:45:30Z")); // 30 s later — older than the 10 s interval
    await svc.get(["CAT"]);
    expect(getQuotes).toHaveBeenCalledTimes(2);
    svc.onModuleDestroy();
  });
});
