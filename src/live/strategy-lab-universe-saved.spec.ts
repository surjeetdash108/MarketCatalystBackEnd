import * as fs from "fs";
import * as path from "path";
import { BadRequestException } from "@nestjs/common";
import { LAB_UNIVERSE_SIZE, StrategyLabService } from "./strategy-lab.service";
import { validateSaved } from "./strategy-lab.controller";

interface Quote {
  symbol: string;
  marketCap: number | null;
  price: number | null;
}
interface Fixture {
  constituents: Array<{ symbol: string; name: string }>;
  quotes: Quote[];
}

/** Real FMP responses captured 2026-10-29: S&P 500 constituents and their batch quotes. */
const fx = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/lab-universe-2026-10-29.json"),
    "utf-8",
  ),
) as Fixture;

type Args = ConstructorParameters<typeof StrategyLabService>;

function serviceWith(constituents: unknown[], quotes: Quote[]) {
  const fmp = {
    request: jest.fn((p: string) =>
      Promise.resolve(p === "sp500-constituent" ? constituents : []),
    ),
    getQuotes: jest.fn((syms: string[]) =>
      Promise.resolve(quotes.filter((q) => syms.includes(q.symbol))),
    ),
  };
  return new StrategyLabService(
    fmp as unknown as Args[0],
    { enabled: false } as unknown as Args[1],
  );
}

const ranked = fx.quotes
  .filter((q): q is Quote & { marketCap: number } => (q.marketCap ?? 0) > 0)
  .sort((a, b) => b.marketCap - a.marketCap);

describe("Strategy Lab universe", () => {
  it("is the 50 largest S&P 500 constituents by market cap, largest first", async () => {
    const u = await serviceWith(fx.constituents, fx.quotes).universe();
    expect(u.stocks).toHaveLength(LAB_UNIVERSE_SIZE);
    const caps = u.stocks.map((s) => s.marketCap);
    expect(caps).toEqual([...caps].sort((a, b) => b - a));
    expect(u.stocks[0].t).toBe(ranked[0].symbol.replace(/-([A-Z])$/, ".$1"));
    expect(u.stocks[LAB_UNIVERSE_SIZE - 1].marketCap).toBe(
      ranked[LAB_UNIVERSE_SIZE - 1].marketCap,
    );
  });

  it("uses the app's share-class spelling (BRK-B → BRK.B)", async () => {
    const u = await serviceWith(fx.constituents, fx.quotes).universe();
    const brk = fx.quotes.find((q) => q.symbol === "BRK-B");
    if (brk && u.stocks.some((s) => s.marketCap === brk.marketCap))
      expect(u.stocks.map((s) => s.t)).toContain("BRK.B");
    expect(u.stocks.some((s) => s.t.includes("-"))).toBe(false);
  });

  it("errors instead of falling back to a fixed list when FMP has nothing", async () => {
    await expect(serviceWith([], []).universe()).rejects.toThrow(
      /no S&P 500 constituents/,
    );
  });
});

describe("saved strategy validation", () => {
  const ok = {
    name: "RSI(2) pullback",
    tf: "15m",
    cond: {
      entry: [{ a: { ind: "rsi", n: 2 }, op: "<", b: { ind: "num", v: 10 } }],
      exit: [],
    },
    cfg: {
      stopM: "atr",
      stopA: "2",
      tpM: "r",
      tpR: "2",
      trA: "never",
      be: "off",
      maxB: "none",
      cost: "10",
      idays_15m: "60",
    },
    q: "buy when rsi(2) below 10",
    why: "Mean reversion",
  };

  it("keeps rules, candle, full exit plan, costs, period, query and why", () => {
    expect(validateSaved(ok)).toEqual({ ...ok, hold: "" });
  });

  it("rejects unknown settings and missing rules", () => {
    expect(() =>
      validateSaved({ ...ok, cfg: { ...ok.cfg, dir: "short" } }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateSaved({ ...ok, cond: { entry: [], exit: [] } }),
    ).toThrow(BadRequestException);
    expect(() => validateSaved({ ...ok, tf: "2d" })).toThrow(
      BadRequestException,
    );
  });
});
