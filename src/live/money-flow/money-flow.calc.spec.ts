import * as fs from "fs";
import * as path from "path";
import {
  buildBoard,
  canonicalTicker,
  etClock,
  fmpTicker,
  isSessionComplete,
  moneyFlow,
  orderBlocks,
  tradeLevels,
  referenceFromGrouped,
  regularSessionBars,
  rejectVolumeOutliers,
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

describe("money flow — levels roll to the next session after the close", () => {
  // Polygon grouped-daily rows for the Oct 29 session, fetched after it closed,
  // plus Polygon's official regular-session open-close bar as the independent truth.
  const closeFx = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../fixtures/money-flow-2026-10-29-close.json"), "utf-8"),
  );
  const grouped = { ...fx.groupedDaily, [SESSION]: closeFx.groupedDaily };
  const after = referenceFromGrouped(grouped, SESSION);
  const AFTER_CLOSE = Date.parse("2026-10-29T21:00:00Z"); // 17:00 ET
  const done = buildBoard({
    sessionDate: SESSION,
    prevSessionDate: after.prevSessionDate,
    now: AFTER_CLOSE,
    stocks: tickers.map((t) => ({ ...stockIn(t), sessionDay: after.sessionDay.get(t) ?? null })),
  });
  const doneT = (t: string) => [...done.gainers, ...done.losers].find((s) => s.t === t)!;
  const classic = (h: number, l: number, c: number) => {
    const p = (h + l + c) / 3;
    return { pivot: p, r1: 2 * p - l, s1: 2 * p - h, r2: p + h - l, s2: p - (h - l) };
  };

  it("the session's own bar is kept apart from the previous session", () => {
    expect(after.prevSessionDate).toBe("2026-10-28");
    expect(after.sessionDay.size).toBe(closeFx.groupedDaily.length);
  });

  it.each(["AAPL", "NOW", "CAT", "KLAC", "MRVL", "XOM", "JPM"])(
    "%s: after the close, R1/R2/S1/S2 are the next session's (from the Oct 29 official bar)",
    (t) => {
      const o = closeFx.officialOpenClose[t];
      const want = classic(o.high, o.low, o.close);
      const got = doneT(t).pivots!;
      for (const k of ["pivot", "r1", "r2", "s1", "s2"] as const) expect(got[k]).toBeCloseTo(want[k], 2);
      expect(done.pivotsFor).toBe("next");
      expect(done.pivotBasisDate).toBe(SESSION);
    },
  );

  it("during the session the levels stay on the previous session", () => {
    expect(board.pivotsFor).toBe("current");
    expect(board.pivotBasisDate).toBe("2026-10-28");
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

  it("rejects single-bar volume outliers where one feed bar carries whole day volume", () => {
    const normalBars = [
      { t: 1000, v: 10_000 },
      { t: 2000, v: 12_000 },
      { t: 3000, v: 11_000 },
      { t: 4000, v: 13_000 },
      { t: 5000, v: 10_000 },
      { t: 6000, v: 12_000 },
    ];
    // Feed glitch on bar 3 carries 5,000,000 shares
    const corrupted = [
      ...normalBars.slice(0, 2),
      { t: 2500, v: 5_000_000 },
      ...normalBars.slice(2),
    ];
    const cleaned = rejectVolumeOutliers(corrupted);
    const outlierBar = cleaned.find((b) => b.t === 2500);
    expect(outlierBar).toBeDefined();
    // Replaced with neighbor median (around 11,000) rather than 5,000,000
    expect(outlierBar!.v).toBeLessThan(20_000);
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

// ── Synthetic sessions for the audit fixes (2026-10-29, EDT: 09:30 ET = 13:30Z) ──
const ET930 = Date.parse("2026-10-29T13:30:00Z");
const bar5 = (k: number, o: number, h: number, l: number, c: number, v = 1000): RawBar => ({ t: ET930 + k * 300_000, o, h, l, c, v });
function synthStock(bars: RawBar[], over: Partial<StockIn> = {}): StockIn {
  return {
    ticker: "AAA", name: "Test", sector: "Tech", inSp500: true, inNasdaq100: false,
    quote: { price: 101, previousClose: 100, changePercentage: 1 },
    bars, prevDay: { h: 101, l: 99, c: 100 }, avgVolume20: 78_000, marketCap: null, ...over,
  };
}

describe("money flow — order blocks: every block counts, not just the newest six", () => {
  // An intact bullish block early on, then six bearish blocks higher up.
  const bars: RawBar[] = [
    bar5(0, 100, 100.1, 99.9, 100), bar5(1, 100, 100.1, 99.9, 100),
    bar5(2, 100, 100, 99.7, 99.8), bar5(3, 99.8, 100.1, 99.8, 100), bar5(4, 100, 100.5, 100, 100.4), // bull block at 2
    bar5(5, 100.4, 101, 100.4, 101), bar5(6, 101, 101.6, 101, 101.6), bar5(7, 101.6, 102, 101.6, 102),
  ];
  for (let c = 0; c < 6; c++) {
    const k = 8 + c * 4;
    bars.push(
      bar5(k, 102, 102.2, 101.95, 102.15), // up
      bar5(k + 1, 102.15, 102.2, 101.9, 102), // down
      bar5(k + 2, 102, 102, 101.6, 101.7), // displacement down → bear block at k
      bar5(k + 3, 101.7, 102.1, 101.7, 102), // recover
    );
  }
  it("finds more than six blocks", () => {
    const b = orderBlocks(bars);
    expect(b.length).toBeGreaterThan(6);
    expect(b[0]).toMatchObject({ bull: true, lo: 99.7, hi: 100, mitigated: false });
  });
  it("the intact bullish block is the zone even with six newer bearish ones", () => {
    const lv = tradeLevels(true, orderBlocks(bars), null, 102);
    expect(lv.zone).toMatchObject({ lo: 99.7, hi: 100 });
    expect(lv.entry).toBe(100);
    expect(lv.stop).toBe(99.7);
  });
});
