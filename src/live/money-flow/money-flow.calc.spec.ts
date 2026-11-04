import * as fs from "fs";
import * as path from "path";
import {
  buildBoard,
  canonicalTicker,
  etClock,
  fmpTicker,
  isSessionComplete,
  moneyFlow,
  reconcileMinuteBars,
  toFiveMinuteBars,
  orderBlocks,
  tradeLevels,
  levelLadder,
  BASIS,
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
    quote: { price: q.price, previousClose: q.previousClose, changePercentage: q.changePercentage, volume: q.volume },
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

  it.each(tickers)("%s: RVOL = the live quote's day volume ÷ (avgVolume20 × share of the session elapsed now)", (t) => {
    const s = byT(t);
    // The quote's volume is the regular session so far, opening auction included and
    // not delayed, so it is measured against the session elapsed at the build time.
    const fraction = (etClock(NOW).minutes - 570) / 390;
    const expected = quote(t).volume / (ref.avgVolume20.get(t)! * fraction);
    expect(Math.abs(s.rvol! / expected - 1)).toBeLessThan(0.01);
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

describe("money flow — relative volume counts the regular session only", () => {
  it("pre-market volume does not inflate RVOL early in the day", () => {
    const pre: RawBar = { t: ET930 - 90 * 60_000, o: 100, h: 100, l: 100, c: 100, v: 1_000_000 }; // 08:00 ET
    const reg = Array.from({ length: 6 }, (_, k) => bar5(k, 100, 100.5, 99.9, 100.2 + k * 0.1, 1000)); // 09:30–10:00
    const b = buildBoard({ sessionDate: "2026-10-29", prevSessionDate: "2026-10-28", now: Date.parse("2026-10-29T14:20:00Z"), stocks: [synthStock([pre, ...reg])] });
    // 6,000 regular-session shares ÷ (78,000 × 30/390 of the session) = 1.0
    expect(b.gainers[0].rvol).toBeCloseTo(1, 5);
  });
});

describe("money flow — one level ladder for targets", () => {
  const piv = { pivot: 100, r1: 102, s1: 98, r2: 104, s2: 96, r3: 106, s3: 94 };
  it("holds the pivot and R1–R5 / S1–S5, low to high", () => {
    const l = levelLadder(piv);
    expect(l.map((x) => x.name)).toEqual(["S5", "S4", "S3", "S2", "S1", "P", "R1", "R2", "R3", "R4", "R5"]);
    expect(l.every((x, i) => i === 0 || x.v > l[i - 1].v)).toBe(true);
  });
  it("a long past R3 targets R4 instead of having no target", () => {
    const blocks = [{ i: 0, t: 0, lo: 106.2, hi: 106.5, bull: true, mitigated: false }];
    const lv = tradeLevels(true, blocks, piv, 107);
    expect(lv.target).toBe(levelLadder(piv).find((x) => x.name === "R4")!.v);
    expect(lv.rr).not.toBeNull();
  });
});

describe("money flow — R:R target = the first shown level on the trade's side, beyond entry and price", () => {
  // Pivots P 100, H 102, L 98: R1 102, R2 104, R3 106, R4 108, R5 110, R6 112…; S1 98, S2 96, S3 94, S4 92, S5 90, S6 88…
  const piv = { pivot: 100, r1: 102, s1: 98, r2: 104, s2: 96, r3: 106, s3: 94 };
  const bull = (lo: number, hi: number) => [{ i: 0, t: 0, lo, hi, bull: true, mitigated: false }];
  const bear = (lo: number, hi: number) => [{ i: 0, t: 0, lo, hi, bull: false, mitigated: false }];
  it("a short past S3 targets S4, the S1 the chart shows (ZBRA: S4 332.31 → 1:7.2)", () => {
    const lv = tradeLevels(false, bear(92.6, 93.0), piv, 92.9); // entry 92.6, stop 93.0, price below S3 94
    expect(lv.target).toBe(92);
    expect(lv.rr).toBeCloseTo(0.6 / 0.4, 9);
  });
  it("a long below the pivot targets R1 (the chart's R1), not the pivot", () => {
    expect(tradeLevels(true, bull(98.8, 99), piv, 99.4).target).toBe(102);
  });
  it("levels price has already passed are skipped (ETN / HSIC): the target is beyond the price too", () => {
    // Long entry 105.5 but price already 106.5, past R3 106 → target R4 108, not R3.
    expect(tradeLevels(true, bull(105, 105.5), piv, 106.5).target).toBe(108);
  });
  it("past R5 / S5 the ladder continues at the same step, so a target still exists", () => {
    expect(tradeLevels(true, bull(110.5, 111), piv, 111.2).target).toBe(112); // R6
    expect(tradeLevels(false, bear(89.0, 89.4), piv, 89.1).target).toBe(88); // S6
  });
  it("never targets a level on the other side of the ladder", () => {
    // A short above the pivot: the first S below entry is S1 98, not the pivot 100.
    expect(tradeLevels(false, bear(100.8, 101.2), piv, 101).target).toBe(98);
  });
});

describe("money flow — confidence's VWAP part uses the live price", () => {
  it("live price above VWAP scores the right side even when the last delayed bar closed below it", () => {
    const reg = [
      bar5(0, 100, 101, 99, 100, 5000), bar5(1, 100, 101, 99.5, 100.5, 5000),
      bar5(2, 100.5, 100.6, 99.3, 99.4, 5000), // last bar closes under the ~100 VWAP
    ];
    const s = synthStock(reg, { quote: { price: 101.5, previousClose: 100, changePercentage: 1.5 } });
    const b = buildBoard({ sessionDate: "2026-10-29", prevSessionDate: "2026-10-28", now: Date.parse("2026-10-29T14:00:00Z"), stocks: [s] });
    const vwapPart = b.gainers[0].confidence!.parts.find((p) => p[0] === "VWAP")!;
    expect(vwapPart[1]).toBeGreaterThanOrEqual(9);
  });
});

describe("money flow — data notes name the feed the code uses", () => {
  it("bars and daily data come FMP-first, Polygon as fallback", () => {
    expect(BASIS.bars).toMatch(/FMP/);
    expect(BASIS.bars).toMatch(/Polygon/);
    expect(BASIS.bars).not.toMatch(/15 minutes delayed/);
    expect(BASIS.pivots).toMatch(/R5/);
  });
});

describe("money flow — bars reconciled across feeds (full regular session)", () => {
  // 09:30 ET on 2026-11-03 (EST), as epoch ms; minute k = 09:30 + k.
  const T0 = Date.parse("2026-11-03T14:30:00Z");
  const m = (k: number, o: number, h: number, l: number, c: number, v: number, vw?: number): RawBar => ({ t: T0 + k * 60_000, o, h, l, c, v, vw });
  // Polygon leaves the opening auction out of the 09:30 bar; FMP drops volume in some minutes.
  const polygon = [m(0, 56.59, 56.8, 55.2, 55.44, 367_223, 55.9), m(1, 55.44, 55.5, 54.8, 54.87, 80_082, 55.1), m(2, 54.87, 55.3, 54.8, 55.16, 82_081, 55.0)];
  const fmp = [m(0, 56.59, 56.8, 55.2, 55.44, 1_042_078), m(1, 55.4, 55.5, 54.8, 54.85, 79_994), m(2, 54.9, 55.3, 54.8, 54.99, 8_000), m(3, 55.0, 56.1, 55.0, 55.99, 178_124)];
  const r = reconcileMinuteBars(polygon, fmp);

  it("keeps Polygon's prices and takes the larger volume of the two per minute", () => {
    expect(r.map((b) => b.v)).toEqual([1_042_078, 80_082, 82_081, 178_124]);
    expect(r.slice(0, 3).map((b) => b.c)).toEqual([55.44, 54.87, 55.16]); // Polygon's closes, not FMP's
  });
  it("a minute whose volume came from FMP drops Polygon's VWAP (it no longer describes that volume); the others keep it", () => {
    expect(r[0].vw).toBeUndefined();
    expect(r[1].vw).toBe(55.1);
  });
  it("minutes only FMP has (Polygon's last ~15 minutes) are taken whole", () => {
    expect(r[3]).toMatchObject({ o: 55.0, c: 55.99, v: 178_124 });
  });
  it("with no FMP bars it is just Polygon's", () => {
    expect(reconcileMinuteBars(polygon, [])).toEqual(polygon);
  });
  it("groups 1-minute bars into 5-minute bars: open first, high max, low min, close last, volume sum, VWAP volume-weighted", () => {
    const five = toFiveMinuteBars([...r, m(4, 56, 56.1, 55.9, 56.06, 159_054, 56.0), m(5, 56.1, 56.5, 56, 56.31, 115_039, 56.3)]);
    expect(five).toHaveLength(2);
    expect(five[0]).toMatchObject({ t: T0, o: 56.59, h: 56.8, l: 54.8, c: 56.06, v: 1_042_078 + 80_082 + 82_081 + 178_124 + 159_054 });
    const tp = (b: RawBar) => b.vw ?? (b.h + b.l + b.c) / 3;
    const first5 = [...r, m(4, 56, 56.1, 55.9, 56.06, 159_054, 56.0)];
    const vw = first5.reduce((a, b) => a + tp(b) * b.v, 0) / first5.reduce((a, b) => a + b.v, 0);
    expect(five[0].vw).toBeCloseTo(vw, 9);
    expect(five[1]).toMatchObject({ t: T0 + 5 * 60_000, o: 56.1, c: 56.31, v: 115_039 });
  });
});

describe("money flow — relative volume from the live quote", () => {
  it("counts the whole regular session so far (opening auction included), not just the bars that arrived", () => {
    const reg = Array.from({ length: 6 }, (_, k) => bar5(k, 100, 100.5, 99.9, 100.2 + k * 0.1, 1000)); // bars hold 6,000 shares
    const s = synthStock(reg, { quote: { price: 101, previousClose: 100, changePercentage: 1, volume: 12_000 } });
    const now = Date.parse("2026-10-29T14:30:00Z"); // 10:30 ET: 60 of 390 minutes
    const b = buildBoard({ sessionDate: "2026-10-29", prevSessionDate: "2026-10-28", now, stocks: [s] });
    expect(b.gainers[0].rvol).toBeCloseTo(12_000 / (78_000 * (60 / 390)), 2);
  });
  it("falls back to the bars when the quote has no volume", () => {
    const reg = Array.from({ length: 6 }, (_, k) => bar5(k, 100, 100.5, 99.9, 100.2 + k * 0.1, 1000));
    const b = buildBoard({ sessionDate: "2026-10-29", prevSessionDate: "2026-10-28", now: Date.parse("2026-10-29T14:20:00Z"), stocks: [synthStock(reg)] });
    expect(b.gainers[0].rvol).toBeCloseTo(1, 5); // 6,000 ÷ (78,000 × 30/390)
  });
});

describe("money flow — the closing auction counts as part of the regular session", () => {
  // 15:55 ET on 2026-11-03 (EST); the closing cross prints in a 16:00 minute bar.
  const T1555 = Date.parse("2026-11-03T20:55:00Z");
  const m = (min: number, c: number, v: number): RawBar => ({ t: T1555 + min * 60_000, o: c, h: c, l: c, c, v });
  const minutes = [m(0, 59.9, 100_000), m(1, 59.95, 100_000), m(2, 60, 100_000), m(3, 60.05, 100_000), m(4, 60.1, 528_273), m(5, 60.2, 1_265_694), m(6, 60.25, 5_000)];
  it("the 16:00 minute (closing print) joins the 15:55 bar; later minutes stay after-hours", () => {
    const five = toFiveMinuteBars(minutes);
    expect(five[0]).toMatchObject({ t: T1555, c: 60.2, v: 4 * 100_000 + 528_273 + 1_265_694 });
    expect(five[1]).toMatchObject({ t: T1555 + 5 * 60_000, v: 5_000 });
  });
  it("so the session's bars carry the closing volume into VWAP and money flow", () => {
    const reg = regularSessionBars(toFiveMinuteBars(minutes), "2026-11-03");
    expect(reg).toHaveLength(1);
    expect(reg[0].v).toBe(4 * 100_000 + 528_273 + 1_265_694);
  });
});
