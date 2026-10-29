import * as fs from "fs";
import * as path from "path";
import {
  buildBoard,
  canonicalTicker,
  etClock,
  fmpTicker,
  isSessionComplete,
  moneyFlow,
  referenceFromGrouped,
  regularSessionBars,
  vwapOf,
  type RawBar,
  type StockIn,
} from "./money-flow.calc";

/**
 * Fixture: real vendor responses captured 2026-10-29 ~13:20 ET (session in
 * progress, Polygon bars through 13:05): Polygon 5-minute bars, Polygon
 * snapshot (its own day VWAP / volume), 21 grouped-daily sessions, FMP quotes,
 * and the app's `companies` docs (sector, avgVolume20, keyLevels.daily).
 * Expected values come from those independent sources, not from this module.
 */
const fx = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../fixtures/money-flow-2026-10-29.json"), "utf-8"),
);
const SESSION: string = fx.session;
const NOW = Date.parse(fx.capturedAt);
const tickers: string[] = fx.tickers;
const quote = (t: string) => fx.fmpQuotes.find((q: { symbol: string }) => q.symbol === t);
const ref = referenceFromGrouped(fx.groupedDaily, SESSION);
const sp = new Set<string>(fx.constituents.sp500.map((x: { symbol: string }) => canonicalTicker(x.symbol)));
const nd = new Set<string>(fx.constituents.nasdaq100.map((x: { symbol: string }) => canonicalTicker(x.symbol)));

function stockIn(t: string): StockIn {
  const q = quote(t);
  return {
    ticker: t,
    name: fx.companies[t]?.name ?? null,
    sector: fx.companies[t]?.sector ?? null,
    inSp500: sp.has(t),
    inNasdaq100: nd.has(t),
    quote: { price: q.price, previousClose: q.previousClose, changePercentage: q.changePercentage },
    bars: fx.bars5m[t],
    prevDay: ref.prevDay.get(t) ?? null,
    avgVolume20: ref.avgVolume20.get(t) ?? null,
    marketCap: null,
  };
}

const board = buildBoard({
  sessionDate: SESSION,
  prevSessionDate: ref.prevSessionDate,
  now: NOW,
  stocks: tickers.map(stockIn),
});
const all = [...board.gainers, ...board.losers];
const byT = (t: string) => all.find((s) => s.t === t)!;

describe("money flow — session bars", () => {
  it("keeps only the regular session (09:30–16:00 ET) of the session date", () => {
    const reg = regularSessionBars(fx.bars5m.AAPL, SESSION);
    expect(fx.bars5m.AAPL.length).toBeGreaterThan(reg.length); // extended-hours bars dropped
    expect(etClock(reg[0].t)).toEqual({ date: SESSION, minutes: 570 });
    for (const b of reg) {
      const { date, minutes } = etClock(b.t);
      expect(date).toBe(SESSION);
      expect(minutes).toBeGreaterThanOrEqual(570);
      expect(minutes).toBeLessThan(960);
    }
  });

  it.each(tickers)("%s: the VWAP method reproduces Polygon's own day VWAP", (t) => {
    const day = fx.polygonSnapshot[t].day;
    const sessionAll = (fx.bars5m[t] as RawBar[]).filter((b) => etClock(b.t).date === SESSION);
    expect(Math.abs(vwapOf(sessionAll)! / day.vw - 1)).toBeLessThan(0.0005);
  });

  it.each(tickers)("%s: day volume matches Polygon's day volume", (t) => {
    expect(Math.abs(byT(t).dayVolume! / fx.polygonSnapshot[t].day.v - 1)).toBeLessThan(0.01);
  });
});

describe("money flow — previous-session reference", () => {
  it("previous session is Oct 28", () => {
    expect(ref.prevSessionDate).toBe("2026-10-28");
  });

  // The app's avgVolume20 for these three was written on the current basis.
  it.each(["AAPL", "XOM", "JPM"])("%s: 20-session average volume = the app's avgVolume20", (t) => {
    expect(Math.abs(ref.avgVolume20.get(t)! / fx.companies[t].avgVolume20 - 1)).toBeLessThan(1e-6);
  });

  // keyLevels.daily written after the Oct 28 session (the 27 stale ones were not).
  it.each(["AAPL", "NOW", "KLAC", "XOM", "JPM"])("%s: pivots = the app's current daily key levels", (t) => {
    const app = fx.companies[t].keyLevels.daily;
    const p = byT(t).pivots!;
    for (const k of ["pivot", "r1", "r2", "s1", "s2"] as const) expect(p[k]).toBeCloseTo(app[k], 2);
  });

  it.each([
    ["CAT", 717.91],
    ["MRVL", 250.51],
  ])("%s: pivot uses Oct 28 (the stale doc still holds Oct 27)", (t, pivot) => {
    expect(byT(t as string).pivots!.pivot).toBeCloseTo(pivot as number, 2);
    expect(byT(t as string).pivots!.pivot).not.toBeCloseTo(fx.companies[t as string].keyLevels.daily.pivot, 1);
  });

  it("previous-day high/low come from the Oct 28 bar", () => {
    const oct28 = fx.groupedDaily["2026-10-28"].find((r: { T: string }) => r.T === "AAPL");
    expect(byT("AAPL").prevHigh).toBe(oct28.h);
    expect(byT("AAPL").prevLow).toBe(oct28.l);
  });
});

describe("money flow — flow arithmetic", () => {
  it("signs each bar by its typical price vs the previous bar (first bar vs prior close)", () => {
    const reg = regularSessionBars(fx.bars5m.AAPL, SESSION).slice(0, 3);
    const prevClose = quote("AAPL").previousClose;
    const tp = reg.map((b) => (b.h + b.l + b.c) / 3);
    let inflow = 0;
    let outflow = 0;
    [prevClose, ...tp.slice(0, 2)].forEach((prev, i) => {
      if (tp[i] > prev) inflow += tp[i] * reg[i].v;
      if (tp[i] < prev) outflow += tp[i] * reg[i].v;
    });
    const f = moneyFlow(reg, prevClose);
    expect(f.inflow).toBeCloseTo(inflow, 0);
    expect(f.outflow).toBeCloseTo(outflow, 0);
    expect(f.net).toBeCloseTo(inflow - outflow, 0);
  });

  it("buy share is inflow ÷ signed flow", () => {
    const f = moneyFlow(regularSessionBars(fx.bars5m.NOW, SESSION), quote("NOW").previousClose);
    expect(f.buyPct).toBeCloseTo((f.inflow / (f.inflow + f.outflow)) * 100, 6);
  });
});

describe("money flow — board", () => {
  it("prices and % changes are the FMP quote's", () => {
    for (const s of all) {
      expect(s.price).toBe(quote(s.t).price);
      expect(s.pctChange).toBeCloseTo(quote(s.t).changePercentage, 2);
    }
  });

  it("gainers are sorted by % move, losers by most negative", () => {
    const g = board.gainers.map((s) => s.pctChange);
    const l = board.losers.map((s) => s.pctChange);
    expect(g).toEqual([...g].sort((a, b) => b - a));
    expect(l).toEqual([...l].sort((a, b) => a - b));
    expect(g.every((x) => x > 0) && l.every((x) => x < 0)).toBe(true);
  });

  it("sectors are the app's (companies), not a hardcoded map", () => {
    for (const s of all) expect(s.sector).toBe(fx.companies[s.t].sector);
    const net = board.sectors.map((x) => x.netFlow);
    expect(net).toEqual([...net].sort((a, b) => b - a));
  });

  it.each(tickers)("%s: RVOL = Polygon day volume ÷ (avgVolume20 × session share)", (t) => {
    const s = byT(t);
    const fraction = (etClock(board.barsThrough!).minutes - 570) / 390;
    const expected = fx.polygonSnapshot[t].day.v / (ref.avgVolume20.get(t)! * fraction);
    expect(Math.abs(s.rvol! / expected - 1)).toBeLessThan(0.02);
  });

  it("breadth counts only S&P 500 members", () => {
    const members = tickers.filter((t) => sp.has(t));
    expect(board.breadth.total).toBe(members.length);
    expect(board.breadth.advancers).toBe(members.filter((t) => quote(t).changePercentage > 0).length);
  });

  it("bars run through 13:05 ET (15-minute delay at capture) and the session is in progress", () => {
    expect(etClock(board.barsThrough!).minutes).toBe(13 * 60 + 10);
    expect(board.sessionComplete).toBe(false);
  });

  it("30-minute change = last close vs six bars earlier, % of previous close", () => {
    const reg = regularSessionBars(fx.bars5m.CAT, SESSION);
    const pc = quote("CAT").previousClose;
    expect(byT("CAT").m30).toBeCloseTo(((reg[reg.length - 1].c - reg[reg.length - 7].c) / pc) * 100, 2);
  });

  it("trade levels sit on an order block, with the target beyond entry", () => {
    for (const s of all) {
      if (!s.zone) {
        expect(s.entry).toBeNull();
        continue;
      }
      const bull = s.pctChange >= 0;
      expect(s.entry).toBe(bull ? s.zone.hi : s.zone.lo);
      expect(s.stop).toBe(bull ? s.zone.lo : s.zone.hi);
      if (s.target != null) expect(bull ? s.target > s.entry! : s.target < s.entry!).toBe(true);
    }
  });
});

describe("money flow — session clock and symbols", () => {
  it("a session is complete 15 minutes after its 16:00 ET close", () => {
    expect(isSessionComplete("2026-10-29", Date.parse("2026-10-29T20:14:00Z"))).toBe(false);
    expect(isSessionComplete("2026-10-29", Date.parse("2026-10-29T20:15:00Z"))).toBe(true);
    expect(isSessionComplete("2026-10-28", NOW)).toBe(true);
  });

  it("ET clock follows DST (Nov 2, 2026 is EST)", () => {
    expect(etClock(Date.parse("2026-11-02T14:30:00Z"))).toEqual({ date: "2026-11-02", minutes: 570 });
    expect(etClock(Date.parse("2026-10-29T13:30:00Z"))).toEqual({ date: "2026-10-29", minutes: 570 });
  });

  it("share-class symbols map between FMP and the app", () => {
    expect(canonicalTicker("BRK-B")).toBe("BRK.B");
    expect(fmpTicker("BRK.B")).toBe("BRK-B");
    expect(canonicalTicker("AAPL")).toBe("AAPL");
  });
});
