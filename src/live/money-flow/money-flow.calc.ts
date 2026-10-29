import { pivotLevels, type PivotLevels } from "../../sync/technical-indicators.job";
import { sessionFraction } from "../../sync/company-quotes.job";

/**
 * Money Flow board — every figure from real bars and quotes.
 *
 * Replaces the UI's seeded random model (ported from a mock-up), which drew the
 * intraday path, candles, volume and dollar flow from a PRNG and a hardcoded
 * 87-name list. Here:
 *   - universe     S&P 500 ∪ Nasdaq-100 constituents (FMP)
 *   - price / %    FMP quote, the live quote source the rest of the app uses
 *   - candles      Polygon 5-minute bars, regular session (09:30–16:00 ET)
 *   - money flow   Money Flow Index method on those bars (see moneyFlow)
 *   - pivots       classic pivots, previous session's high/low + official close
 *   - RVOL         day volume ÷ (20-session average × share of session elapsed),
 *                  the company-quotes job's definition
 *
 * Pure: the service fetches, this file computes, so the spec can run it on
 * saved vendor responses.
 */

export interface RawBar {
  /** Bar start, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number | null;
}

export interface SessionBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Regular-session VWAP through the close of this bar. */
  vwap: number;
}

export const BAR_MINUTES = 5;
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
/** Polygon Stocks Starter delay. */
export const DATA_DELAY_MINUTES = 15;
/** Gainer / loser boards: the 15 biggest movers each side. */
export const BOARD_SIZE = 15;

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** ET calendar date (YYYY-MM-DD) and minutes after midnight of an instant. */
export function etClock(ms: number): { date: string; minutes: number } {
  const p = Object.fromEntries(ET_FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
  };
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Bars of `sessionDate`'s regular session, with the running session VWAP. */
export function regularSessionBars(bars: RawBar[], sessionDate: string): SessionBar[] {
  const out: SessionBar[] = [];
  let pv = 0;
  let vol = 0;
  for (const b of [...bars].sort((a, z) => a.t - z.t)) {
    if (![b.o, b.h, b.l, b.c].every(finite) || !finite(b.v) || b.v < 0) continue;
    const { date, minutes } = etClock(b.t);
    if (date !== sessionDate || minutes < OPEN_MIN || minutes >= CLOSE_MIN) continue;
    pv += (finite(b.vw) ? b.vw : (b.h + b.l + b.c) / 3) * b.v;
    vol += b.v;
    out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vwap: vol > 0 ? pv / vol : b.c });
  }
  return out;
}

/** Volume-weighted average price of a set of bars (Σ vw·v ÷ Σ v). */
export function vwapOf(bars: RawBar[]): number | null {
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    if (!finite(b.v) || b.v <= 0) continue;
    pv += (finite(b.vw) ? b.vw : (b.h + b.l + b.c) / 3) * b.v;
    vol += b.v;
  }
  return vol > 0 ? pv / vol : null;
}

export interface FlowResult {
  /** Inflow − outflow, $. */
  net: number;
  inflow: number;
  outflow: number;
  /** Inflow share of all signed flow, %. Null with no flow yet. */
  buyPct: number | null;
}

/**
 * Money flow, Money Flow Index method: each bar's typical price (H+L+C)/3 ×
 * volume is inflow when the typical price rose from the previous bar and
 * outflow when it fell (unchanged bars count for neither). The first bar is
 * compared with the previous session's close.
 */
export function moneyFlow(bars: Array<Pick<RawBar, "h" | "l" | "c" | "v">>, prevClose: number | null): FlowResult {
  let inflow = 0;
  let outflow = 0;
  let prevTp = finite(prevClose) && prevClose > 0 ? prevClose : null;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    const raw = tp * b.v;
    if (prevTp != null) {
      if (tp > prevTp) inflow += raw;
      else if (tp < prevTp) outflow += raw;
    }
    prevTp = tp;
  }
  const gross = inflow + outflow;
  return { net: inflow - outflow, inflow, outflow, buyPct: gross > 0 ? (inflow / gross) * 100 : null };
}

export interface SwingPoint {
  i: number;
  p: number;
  hi: boolean;
}

/** Swing highs/lows: a bar whose high (low) is strictly above (below) the `n` bars each side. */
export function swings(c: Array<Pick<RawBar, "h" | "l">>, n = 3): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = n; i < c.length - n; i++) {
    let H = true;
    let L = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (c[j].h >= c[i].h) H = false;
      if (c[j].l <= c[i].l) L = false;
    }
    if (H) out.push({ i, p: c[i].h, hi: true });
    if (L) out.push({ i, p: c[i].l, hi: false });
  }
  return out;
}

export interface OrderBlock {
  i: number;
  t: number;
  hi: number;
  lo: number;
  bull: boolean;
  /** Price has since traded back through the block. */
  mitigated: boolean;
}

/**
 * Order blocks: the last opposite candle before a displacement — a down candle,
 * then an up candle, then a close more than 0.18% above the down candle's high
 * (bullish); mirrored for bearish. Mitigated once a later bar trades back
 * through the block's far side. The six most recent.
 */
export function orderBlocks(c: Array<Pick<RawBar, "t" | "o" | "h" | "l" | "c">>): OrderBlock[] {
  const out: OrderBlock[] = [];
  for (let i = 2; i < c.length - 2; i++) {
    const bar = c[i];
    const n1 = c[i + 1];
    const n2 = c[i + 2];
    const bull = bar.c < bar.o && n1.c > n1.o && (n2.c - bar.h) / bar.h > 0.0018;
    const bear = bar.c > bar.o && n1.c < n1.o && (bar.l - n2.c) / bar.l > 0.0018;
    if (!bull && !bear) continue;
    let mitigated = false;
    for (let j = i + 2; j < c.length; j++) {
      if (bull ? c[j].l <= bar.l : c[j].h >= bar.h) {
        mitigated = true;
        break;
      }
    }
    out.push({ i, t: bar.t, hi: bar.h, lo: bar.l, bull, mitigated });
  }
  return out.slice(-6);
}

/** Change over the last 30 minutes (six 5-minute bars), in % of the previous close. */
export function change30m(bars: Array<Pick<RawBar, "c">>, prevClose: number | null): number | null {
  const n = bars.length;
  if (n < 7 || !finite(prevClose) || prevClose <= 0) return null;
  return ((bars[n - 1].c - bars[n - 7].c) / prevClose) * 100;
}

export interface TradeLevels {
  zone: { lo: number; hi: number; startT: number } | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  rr: number | null;
}

/**
 * Trade levels from the most recent unmitigated order block on the stock's side
 * of the move: entry at the block's near edge, stop at its far edge, target at
 * the first pivot level beyond both entry and price (R1→R3 long, S1→S3 short).
 * No block → no levels.
 */
export function tradeLevels(bull: boolean, blocks: OrderBlock[], piv: PivotLevels | null, price: number): TradeLevels {
  const ob = blocks.filter((b) => !b.mitigated && b.bull === bull).slice(-1)[0];
  if (!ob) return { zone: null, entry: null, stop: null, target: null, rr: null };
  const entry = bull ? ob.hi : ob.lo;
  const stop = bull ? ob.lo : ob.hi;
  const ladder = piv ? (bull ? [piv.r1, piv.r2, piv.r3] : [piv.s1, piv.s2, piv.s3]) : [];
  const target =
    ladder.find((v) => finite(v) && (bull ? v > Math.max(entry, price) : v < Math.min(entry, price))) ?? null;
  const risk = Math.abs(entry - stop);
  const rr = target != null && risk > 0 ? Math.abs(target - entry) / risk : null;
  return { zone: { lo: ob.lo, hi: ob.hi, startT: ob.t }, entry, stop, target, rr };
}

export interface ConfidenceInput {
  pctChange: number;
  /** |% change| of every priced stock moving the same way (ascending). */
  sameSideMoves: number[];
  rvol: number | null;
  lastClose: number;
  vwap: number;
  m30: number | null;
  bars: Array<Pick<RawBar, "t" | "o" | "h" | "l" | "c">>;
  /** This stock's sector net flow ÷ the largest |sector net flow|. */
  sectorFlowRatio: number;
  buyPct: number | null;
  chop: boolean;
}

export interface Confidence {
  score: number;
  parts: Array<[string, number, number]>;
}

/**
 * Confidence 1–99: trend rank 30, relative volume 15, VWAP side 15, 30-minute
 * momentum 10, swing structure 10, sector flow 10, buy share 10, order-block
 * proximity +5; ×0.88 when choppy. Weights are the board's published scheme
 * (glossary); every input is measured.
 */
export function confidence(x: ConfidenceInput): Confidence {
  const dir = x.pctChange >= 0 ? 1 : -1;
  const side = x.sameSideMoves;
  let pctl = 1;
  if (side.length >= 2) {
    let idx = 0;
    while (idx < side.length && side[idx] < Math.abs(x.pctChange)) idx++;
    pctl = idx / (side.length - 1);
  }
  const trend = 30 * Math.pow(clamp(pctl, 0, 1), 0.8);
  const vol = x.rvol == null ? 0 : 15 * clamp((x.rvol - 0.8) / 1.4, 0, 1);
  const vd = ((dir * (x.lastClose - x.vwap)) / x.vwap) * 100;
  const vwap = vd <= 0 ? 3 * clamp(1 + vd / 0.3, 0, 1) : 9 + 6 * clamp(vd / 0.6, 0, 1);
  const mom = x.m30 == null ? 0 : 10 * clamp(0.5 + (x.m30 * dir) / 0.4, 0, 1);

  const sw = swings(x.bars, 3);
  const hs = sw.filter((p) => p.hi).slice(-3);
  const ls = sw.filter((p) => !p.hi).slice(-3);
  let st = 0;
  let n = 0;
  for (let i = 1; i < hs.length; i++) {
    n++;
    if ((hs[i].p - hs[i - 1].p) * dir > 0) st++;
  }
  for (let i = 1; i < ls.length; i++) {
    n++;
    if ((ls[i].p - ls[i - 1].p) * dir > 0) st++;
  }
  const structure = n ? (10 * st) / n : 0;
  const sector = 10 * clamp(0.5 + dir * x.sectorFlowRatio * 0.6, 0, 1);
  const money = x.buyPct == null ? 0 : 10 * clamp(0.5 + (dir > 0 ? x.buyPct - 50 : 50 - x.buyPct) / 40, 0, 1);

  const ob = orderBlocks(x.bars).filter((b) => !b.mitigated && b.bull === dir > 0).slice(-1)[0];
  const obd = ob ? Math.max(0, ((dir > 0 ? x.lastClose - ob.hi : ob.lo - x.lastClose) / x.lastClose) * 100) : null;
  const obScore = ob && obd != null ? 5 * clamp(1 - obd / 1.5, 0.3, 1) : 0;

  let sc = trend + vol + vwap + mom + structure + sector + money + obScore;
  if (x.chop) sc *= 0.88;
  return {
    score: Math.round(clamp(sc, 1, 99)),
    parts: [
      ["Trend", round(trend, 1), 30],
      ["Rel. volume", round(vol, 1), 15],
      ["VWAP", round(vwap, 1), 15],
      ["30m momentum", round(mom, 1), 10],
      ["Structure", round(structure, 1), 10],
      ["Sector flow", round(sector, 1), 10],
      ["Big money", round(money, 1), 10],
      ["Order block bonus", round(obScore, 1), 5],
    ],
  };
}

// ── Reference data from grouped daily bars ──────────────────────────────────

export interface GroupedRow {
  T: string;
  h: number;
  l: number;
  c: number;
  v: number;
}

export const AVG_VOLUME_SESSIONS = 20;

/**
 * From Polygon grouped-daily responses keyed by date: the previous session
 * (latest date before `sessionDate` with rows), each ticker's bar on it, and the
 * mean daily volume of the 20 sessions before `sessionDate` (the companies
 * `avgVolume20` basis). A ticker missing from any of those sessions gets no
 * average rather than one over fewer days.
 */
export function referenceFromGrouped(
  grouped: Record<string, GroupedRow[]>,
  sessionDate: string,
): {
  prevSessionDate: string | null;
  prevDay: Map<string, { h: number; l: number; c: number }>;
  avgVolume20: Map<string, number>;
} {
  const dates = Object.keys(grouped)
    .filter((d) => d < sessionDate && grouped[d].length > 0)
    .sort()
    .slice(-AVG_VOLUME_SESSIONS);
  const prevSessionDate = dates.length ? dates[dates.length - 1] : null;
  const prevDay = new Map<string, { h: number; l: number; c: number }>();
  for (const r of prevSessionDate ? grouped[prevSessionDate] : []) {
    if ([r.h, r.l, r.c].every(finite)) prevDay.set(r.T, { h: r.h, l: r.l, c: r.c });
  }
  const sums = new Map<string, { v: number; n: number }>();
  for (const d of dates) {
    for (const r of grouped[d]) {
      if (!finite(r.v)) continue;
      const s = sums.get(r.T) ?? { v: 0, n: 0 };
      s.v += r.v;
      s.n += 1;
      sums.set(r.T, s);
    }
  }
  const avgVolume20 = new Map<string, number>();
  if (dates.length === AVG_VOLUME_SESSIONS) {
    for (const [t, s] of sums) if (s.n === AVG_VOLUME_SESSIONS) avgVolume20.set(t, s.v / s.n);
  }
  return { prevSessionDate, prevDay, avgVolume20 };
}

/** FMP writes share classes with a dash (BRK-B); Polygon and the app use a dot (BRK.B). */
export function canonicalTicker(fmpSymbol: string): string {
  return fmpSymbol.trim().toUpperCase().replace(/^([A-Z]+)-([A-Z])$/, "$1.$2");
}

/** The FMP spelling of a canonical ticker. */
export function fmpTicker(ticker: string): string {
  return ticker.replace(/^([A-Z]+)\.([A-Z])$/, "$1-$2");
}

// ── Board assembly ──────────────────────────────────────────────────────────

export interface QuoteIn {
  price: number | null;
  previousClose: number | null;
  changePercentage: number | null;
}

export interface StockIn {
  ticker: string;
  name: string | null;
  sector: string | null;
  inSp500: boolean;
  inNasdaq100: boolean;
  quote: QuoteIn | null;
  /** All of the session date's 5-minute bars (extended hours included). */
  bars: RawBar[];
  /** Previous session's daily bar (Polygon). */
  prevDay: { h: number; l: number; c: number } | null;
  /** Mean daily volume of the 20 sessions before the session date. */
  avgVolume20: number | null;
  marketCap: number | null;
}

export interface BoardIn {
  sessionDate: string;
  prevSessionDate: string | null;
  /** Wall-clock time of the build. */
  now: number;
  stocks: StockIn[];
}

export interface BoardBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vwap: number;
}

export interface BoardStock {
  t: string;
  name: string | null;
  sector: string | null;
  inSp500: boolean;
  inNasdaq100: boolean;
  price: number;
  prevClose: number;
  pctChange: number;
  marketCap: number | null;
  dayVolume: number | null;
  avgVolume20: number | null;
  rvol: number | null;
  vwap: number | null;
  netFlow: number;
  buyPct: number | null;
  m30: number | null;
  /** % move minus the sector's average % move. */
  vsSector: number | null;
  chop: boolean;
  pivots: PivotLevels | null;
  prevHigh: number | null;
  prevLow: number | null;
  zone: TradeLevels["zone"];
  entry: number | null;
  stop: number | null;
  target: number | null;
  rr: number | null;
  confidence: Confidence | null;
  bars: BoardBar[];
}

export interface BoardSector {
  name: string;
  netFlow: number;
  inflow: number;
  outflow: number;
  buyPct: number | null;
  /** Equal-weighted mean % move of the sector's priced stocks. */
  avgPct: number;
  count: number;
}

export interface MoneyFlowBoard {
  asOf: string;
  sessionDate: string;
  prevSessionDate: string | null;
  sessionComplete: boolean;
  /** End of the latest regular-session bar (epoch ms), null before any. */
  barsThrough: number | null;
  delayMinutes: number;
  universe: { sp500: number; nasdaq100: number; total: number; priced: number; withBars: number };
  breadth: { advancers: number; decliners: number; unchanged: number; total: number };
  sectors: BoardSector[];
  gainers: BoardStock[];
  losers: BoardStock[];
  basis: Record<string, string>;
}

export const BASIS: Record<string, string> = {
  universe: "S&P 500 and Nasdaq-100 constituents (FMP); a stock in both counts once.",
  price: "FMP quote: last price and % change from the previous official close.",
  bars: "Polygon 5-minute bars, regular session 09:30–16:00 ET, 15 minutes delayed.",
  moneyFlow:
    "Money Flow Index method: typical price (H+L+C)/3 × volume per 5-minute bar, inflow when the typical price rose from the prior bar, outflow when it fell. Net = inflow − outflow; sector = sum of its stocks.",
  buyPct: "Inflow ÷ (inflow + outflow).",
  sectorPct: "Equal-weighted average % move of the sector's stocks.",
  breadth: "S&P 500 constituents up / down / unchanged vs the previous close.",
  rvol: "Day volume ÷ (20-session average daily volume × share of the regular session elapsed).",
  vwap: "Regular-session VWAP from the 5-minute bars.",
  m30: "Change over the last 30 minutes (six 5-minute bars), in % of the previous close.",
  pivots: "Classic pivots from the previous session's high/low (Polygon daily bar) and official close.",
  zone: "Most recent unmitigated order block on the side of the move (5-minute bars).",
  levels: "Entry = zone edge nearest price, stop = far edge, target = first pivot beyond entry and price; R:R = |target − entry| ÷ |entry − stop|.",
  marketCap: "Polygon weighted shares outstanding × price (as Stock Detail).",
  sector: "App sector (companies), else SIC-derived like Stock Detail.",
};

/** Session complete once its 16:00 ET close is older than the data delay. */
export function isSessionComplete(sessionDate: string, now: number): boolean {
  const { date, minutes } = etClock(now);
  return date > sessionDate || (date === sessionDate && minutes >= CLOSE_MIN + DATA_DELAY_MINUTES);
}

export function buildBoard(input: BoardIn): MoneyFlowBoard {
  const complete = isSessionComplete(input.sessionDate, input.now);
  type Work = {
    s: StockIn;
    price: number;
    prevClose: number;
    pct: number;
    reg: SessionBar[];
    flow: FlowResult;
    dayVolume: number | null;
  };
  const work: Work[] = [];
  let barsThrough: number | null = null;
  for (const s of input.stocks) {
    const q = s.quote;
    if (!q || !finite(q.price) || q.price <= 0 || !finite(q.previousClose) || q.previousClose <= 0) continue;
    const pct = finite(q.changePercentage) ? q.changePercentage : ((q.price - q.previousClose) / q.previousClose) * 100;
    const reg = regularSessionBars(s.bars, input.sessionDate);
    const sessionAll = s.bars.filter((b) => etClock(b.t).date === input.sessionDate && finite(b.v));
    const dayVolume = sessionAll.length ? sessionAll.reduce((a, b) => a + b.v, 0) : null;
    if (reg.length) {
      const end = reg[reg.length - 1].t + BAR_MINUTES * 60_000;
      if (barsThrough == null || end > barsThrough) barsThrough = end;
    }
    work.push({
      s,
      price: q.price,
      prevClose: q.previousClose,
      pct,
      reg,
      flow: moneyFlow(reg, q.previousClose),
      dayVolume,
    });
  }

  // Elapsed share for RVOL and the chop threshold, at the data's own time.
  const fraction = complete ? 1 : barsThrough != null ? sessionFraction(barsThrough) : null;

  const sectorMap = new Map<string, { inflow: number; outflow: number; pcts: number[] }>();
  for (const w of work) {
    if (!w.s.sector) continue;
    const m = sectorMap.get(w.s.sector) ?? { inflow: 0, outflow: 0, pcts: [] };
    m.inflow += w.flow.inflow;
    m.outflow += w.flow.outflow;
    m.pcts.push(w.pct);
    sectorMap.set(w.s.sector, m);
  }
  const sectors: BoardSector[] = [...sectorMap.entries()]
    .map(([name, m]) => ({
      name,
      netFlow: Math.round(m.inflow - m.outflow),
      inflow: Math.round(m.inflow),
      outflow: Math.round(m.outflow),
      buyPct: m.inflow + m.outflow > 0 ? round((m.inflow / (m.inflow + m.outflow)) * 100, 1) : null,
      avgPct: round(m.pcts.reduce((a, b) => a + b, 0) / m.pcts.length, 2),
      count: m.pcts.length,
    }))
    .sort((a, b) => b.netFlow - a.netFlow);
  const sectorNet = new Map(sectors.map((x) => [x.name, x.netFlow]));
  const sectorAvg = new Map(sectors.map((x) => [x.name, x.avgPct]));
  const maxSectorFlow = Math.max(1, ...sectors.map((x) => Math.abs(x.netFlow)));

  const upMoves = work.filter((w) => w.pct >= 0).map((w) => Math.abs(w.pct)).sort((a, b) => a - b);
  const downMoves = work.filter((w) => w.pct < 0).map((w) => Math.abs(w.pct)).sort((a, b) => a - b);
  const chopThr = 0.6 * Math.min(1, 0.35 + (fraction ?? 0));

  const toStock = (w: Work): BoardStock => {
    const bull = w.pct >= 0;
    const rvol =
      w.dayVolume != null && finite(w.s.avgVolume20) && w.s.avgVolume20 > 0 && fraction != null
        ? round(w.dayVolume / (w.s.avgVolume20 * fraction), 2)
        : null;
    const chop = Math.abs(w.pct) < chopThr || (rvol != null && rvol < 1.05);
    const piv = w.s.prevDay ? pivotLevels(w.s.prevDay.h, w.s.prevDay.l, w.prevClose) : null;
    const last = w.reg[w.reg.length - 1];
    const blocks = orderBlocks(w.reg);
    const lv = tradeLevels(bull, blocks, piv, w.price);
    const m30 = change30m(w.reg, w.prevClose);
    const conf = last
      ? confidence({
          pctChange: w.pct,
          sameSideMoves: bull ? upMoves : downMoves,
          rvol,
          lastClose: last.c,
          vwap: last.vwap,
          m30,
          bars: w.reg,
          sectorFlowRatio: w.s.sector ? (sectorNet.get(w.s.sector) ?? 0) / maxSectorFlow : 0,
          buyPct: w.flow.buyPct,
          chop,
        })
      : null;
    const avg = w.s.sector ? sectorAvg.get(w.s.sector) : undefined;
    return {
      t: w.s.ticker,
      name: w.s.name,
      sector: w.s.sector,
      inSp500: w.s.inSp500,
      inNasdaq100: w.s.inNasdaq100,
      price: w.price,
      prevClose: w.prevClose,
      pctChange: round(w.pct, 2),
      marketCap: w.s.marketCap,
      dayVolume: w.dayVolume,
      avgVolume20: w.s.avgVolume20,
      rvol,
      vwap: last ? round(last.vwap, 4) : null,
      netFlow: Math.round(w.flow.net),
      buyPct: w.flow.buyPct == null ? null : round(w.flow.buyPct, 1),
      m30: m30 == null ? null : round(m30, 2),
      vsSector: avg == null ? null : round(w.pct - avg, 2),
      chop,
      pivots: piv,
      prevHigh: w.s.prevDay?.h ?? null,
      prevLow: w.s.prevDay?.l ?? null,
      zone: lv.zone,
      entry: lv.entry,
      stop: lv.stop,
      target: lv.target,
      rr: lv.rr == null ? null : round(lv.rr, 2),
      confidence: conf,
      bars: w.reg.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vwap: round(b.vwap, 4) })),
    };
  };

  const gainers = work.filter((w) => w.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, BOARD_SIZE).map(toStock);
  const losers = work.filter((w) => w.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, BOARD_SIZE).map(toStock);

  const sp = work.filter((w) => w.s.inSp500);
  const breadth = {
    advancers: sp.filter((w) => w.pct > 0).length,
    decliners: sp.filter((w) => w.pct < 0).length,
    unchanged: sp.filter((w) => w.pct === 0).length,
    total: sp.length,
  };

  return {
    asOf: new Date(input.now).toISOString(),
    sessionDate: input.sessionDate,
    prevSessionDate: input.prevSessionDate,
    sessionComplete: complete,
    barsThrough,
    delayMinutes: DATA_DELAY_MINUTES,
    universe: {
      sp500: input.stocks.filter((s) => s.inSp500).length,
      nasdaq100: input.stocks.filter((s) => s.inNasdaq100).length,
      total: input.stocks.length,
      priced: work.length,
      withBars: work.filter((w) => w.reg.length > 0).length,
    },
    breadth,
    sectors,
    gainers,
    losers,
    basis: BASIS,
  };
}
