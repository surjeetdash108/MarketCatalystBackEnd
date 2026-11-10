import * as fs from "fs";
import * as path from "path";
import {
  LAB_UNIVERSE_CAP,
  LabUniverseService,
  universeFor,
} from "./lab-universe";
import { LabStoreService } from "./lab-store.service";
import { StrategyLabService } from "../strategy-lab.service";

interface Quote {
  symbol: string;
  marketCap: number | null;
}
/** Real FMP responses captured 2026-10-29: S&P 500 constituents and their batch quotes. */
const fx = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../fixtures/lab-universe-2026-10-29.json"),
    "utf-8",
  ),
) as { constituents: Array<{ symbol: string; name: string }>; quotes: Quote[] };

const fmpWith = (constituents: unknown[], quotes: Quote[]) => ({
  request: jest.fn((p: string) =>
    Promise.resolve(p === "sp500-constituent" ? constituents : []),
  ),
  getQuotes: jest.fn((syms: string[]) =>
    Promise.resolve(quotes.filter((q) => syms.includes(q.symbol))),
  ),
});
const ranked = fx.quotes
  .filter((q) => (q.marketCap ?? 0) > 0)
  .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
type U = ConstructorParameters<typeof LabUniverseService>[0];

describe("Strategy Lab universe (shared by the browser scan and the jobs)", () => {
  it("is every priced S&P 500 constituent, largest market cap first", async () => {
    const u = await new LabUniverseService(
      fmpWith(fx.constituents, fx.quotes) as unknown as U,
    ).get();
    expect(u.stocks).toHaveLength(ranked.length);
    expect(u.stocks.length).toBeGreaterThan(500);
    const caps = u.stocks.map((s) => s.marketCap);
    expect(caps).toEqual([...caps].sort((a, b) => b - a));
    expect(u.stocks[0].t).toBe(ranked[0].symbol);
    expect(u.stocks.some((s) => s.t.includes("-"))).toBe(false);
    expect(u.source).toMatch(/S&P 500/);
  });

  it("caps per candle and by an explicit size, never reordering", async () => {
    const u = await new LabUniverseService(
      fmpWith(fx.constituents, fx.quotes) as unknown as U,
    ).get();
    expect(Object.keys(LAB_UNIVERSE_CAP).sort()).toEqual(
      ["1h", "1m", "1w", "4h", "5m", "15m", "30m", "d"].sort(),
    );
    expect(Object.values(LAB_UNIVERSE_CAP).every((v) => v === null)).toBe(true);
    expect(universeFor(u.stocks, "d")).toHaveLength(u.stocks.length);
    expect(universeFor(u.stocks, "5m")).toHaveLength(u.stocks.length);
    expect(universeFor(u.stocks, "1m")).toHaveLength(u.stocks.length);
    const top = universeFor(u.stocks, "5m", 100);
    expect(top).toHaveLength(100);
    expect(top).toEqual(u.stocks.slice(0, 100));
    expect(universeFor(u.stocks, "d", 0)).toHaveLength(u.stocks.length);
  });

  it("the browser /universe and the jobs' store read the same list", async () => {
    const svc = new LabUniverseService(
      fmpWith(fx.constituents, fx.quotes) as unknown as U,
    );
    const companies = jest.fn();
    const store = new LabStoreService(
      { firestore: { collection: companies } } as never,
      svc,
    );
    const lab = new StrategyLabService(
      {} as never,
      { enabled: false } as never,
      svc,
      {} as never,
      { get: () => "" } as never,
    );
    const a = (await lab.universe()).stocks.map((s) => s.t);
    const b = (await store.universe()).map((s) => s.t);
    expect(b).toEqual(a);
    expect(companies).not.toHaveBeenCalled();
  });

  it("errors instead of falling back to a fixed list when FMP has nothing", async () => {
    await expect(
      new LabUniverseService(fmpWith([], []) as unknown as U).get(),
    ).rejects.toThrow(/no S&P 500 constituents/);
  });
});
