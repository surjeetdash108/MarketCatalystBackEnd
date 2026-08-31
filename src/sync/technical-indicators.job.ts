import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  type PendingWrite,
} from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { activeUniverse } from "../common/ticker-universe";
import { SyncRegistry } from "../common/sync-registry.service";
import { PolygonService } from "../vendors/polygon/polygon.service";

const JOB_NAME = "technical-indicators";
// >=252 so the 52-week high/low is a real rolling year rather than "whatever
// history happens to be loaded". 200-DMA needs 200; the binding constraint is
// the 52-week window, so this is 252 plus a margin for holidays/halts.
const BARS_TO_READ = 300;
const MIN_BARS = 40;
const RVOL_WINDOW = 20;
const TRADING_DAYS_YEAR = 252;
/** Periods the Stock Detail moving-average drawer renders. */
const MA_PERIODS = [10, 20, 30, 50, 100, 200];
/** How many trailing RSI values to persist for the sparkline pane. */
const RSI_SERIES_LEN = 90;

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

export function rsi(closes: number[], period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Stochastic %K over `period` — where the last close sits in the period range. */
function stochK(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number | null {
  if (closes.length < period) return null;
  const hh = Math.max(...highs.slice(-period));
  const ll = Math.min(...lows.slice(-period));
  const c = closes[closes.length - 1];
  if (!Number.isFinite(hh) || !Number.isFinite(ll) || hh === ll) return null;
  return ((c - ll) / (hh - ll)) * 100;
}

/** Wilder ADX(14) — trend strength from smoothed +DI/-DI. */
function adx(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number | null {
  const n = closes.length;
  if (n < period * 2 + 1) return null;
  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const dn = lows[i - 1] - lows[i];
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
  }
  // Wilder smoothing (running sum, not simple average).
  const smooth = (arr: number[]): number[] => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) {
      s = s - s / period + arr[i];
      out.push(s);
    }
    return out;
  };
  const trS = smooth(tr);
  const pS = smooth(plusDM);
  const mS = smooth(minusDM);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    if (trS[i] === 0) {
      dx.push(0);
      continue;
    }
    const pdi = (100 * pS[i]) / trS[i];
    const mdi = (100 * mS[i]) / trS[i];
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum);
  }
  if (dx.length < period) return null;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++)
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
  return adxVal;
}

/** Beta vs a benchmark: cov(ticker, mkt) / var(mkt) over date-aligned daily returns. */
function betaVs(
  bars: { barDate: string; close: number }[],
  mktByDate: Map<string, number>,
): number | null {
  const rt: number[] = [];
  const rm: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const s = mktByDate.get(bars[i].barDate);
    const sPrev = mktByDate.get(bars[i - 1].barDate);
    const c = bars[i].close;
    const cPrev = bars[i - 1].close;
    if (
      s == null ||
      sPrev == null ||
      sPrev <= 0 ||
      cPrev == null ||
      cPrev <= 0 ||
      c == null
    )
      continue;
    rt.push((c - cPrev) / cPrev);
    rm.push((s - sPrev) / sPrev);
  }
  const N = Math.min(rt.length, 252);
  if (N < 60) return null;
  const a = rt.slice(-N);
  const b = rm.slice(-N);
  const ma = a.reduce((x, y) => x + y, 0) / N;
  const mb = b.reduce((x, y) => x + y, 0) / N;
  let cov = 0;
  let varb = 0;
  for (let i = 0; i < N; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    varb += (b[i] - mb) ** 2;
  }
  if (varb === 0) return null;
  return cov / varb;
}

function macd(closes: number[]) {
  if (closes.length < 35) return null;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const line = closes.map((_, i) => ema12[i] - ema26[i]);
  const signal = ema(line, 9);
  const i = closes.length - 1;
  return {
    macd: line[i],
    signal: signal[i],
    histogram: line[i] - signal[i],
  };
}

function rvol(volumes: number[], window = RVOL_WINDOW) {
  if (volumes.length < window + 1) return null;
  const latest = volumes[volumes.length - 1];
  const prior = volumes.slice(-window - 1, -1);
  const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
  return avg > 0 ? latest / avg : null;
}

/** Simple moving average of the last `period` closes, or null if too few bars. */
function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  return window.reduce((a, b) => a + b, 0) / period;
}

/**
 * Rolling RSI, one value per bar once the seed window is filled (Wilder
 * smoothing, same recurrence as rsi() above). rsi() returns only the final
 * scalar; the RSI pane needs the whole line, which it was drawing as a seeded
 * sine-plus-noise walk.
 */
export function rsiSeries(closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const out: number[] = [
    avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss),
  ];
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

/** Trailing average of the last `period` values, or null if too few. */
function trailingAvg(values: number[], period: number): number | null {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

const round2 = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;

/** Percent change over the last `sessions` trading days (closes oldest→newest). */
function changeOverSessions(closes: number[], sessions: number): number | null {
  if (closes.length < sessions + 1) return null;
  const latest = closes[closes.length - 1];
  const past = closes[closes.length - 1 - sessions];
  return past > 0 ? ((latest - past) / past) * 100 : null;
}

/**
 * Classic (floor-trader) pivot points from a prior period's H/L/C — the support
 * & resistance levels the "Key levels" widget/drawer render. Derived from the
 * Polygon bars we already store (no vendor has a native S/R feed).
 */
interface PivotLevels {
  pivot: number | null;
  r1: number | null;
  r2: number | null;
  r3: number | null;
  s1: number | null;
  s2: number | null;
  s3: number | null;
}

function pivotLevels(high: number, low: number, close: number): PivotLevels {
  const p = (high + low + close) / 3;
  const range = high - low;
  return {
    pivot: round2(p),
    r1: round2(2 * p - low),
    s1: round2(2 * p - high),
    r2: round2(p + range),
    s2: round2(p - range),
    r3: round2(high + 2 * (p - low)),
    s3: round2(low - 2 * (high - p)),
  };
}

/** Monday (UTC) of the week containing `dateStr` (YYYY-MM-DD) — a week key. */
function weekKey(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** Aggregate H/L/C of the last COMPLETE week (excludes the current partial week). */
function priorWeekHLC(
  bars: Array<{ barDate?: string; high?: number; low?: number; close?: number }>,
): { high: number; low: number; close: number } | null {
  const weeks = new Map<
    string,
    { high: number; low: number; close: number; last: string }
  >();
  for (const b of bars) {
    if (
      !b.barDate ||
      typeof b.high !== "number" ||
      typeof b.low !== "number" ||
      typeof b.close !== "number"
    )
      continue;
    const wk = weekKey(b.barDate);
    const cur = weeks.get(wk);
    if (!cur) {
      weeks.set(wk, { high: b.high, low: b.low, close: b.close, last: b.barDate });
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      if (b.barDate >= cur.last) {
        cur.close = b.close;
        cur.last = b.barDate;
      }
    }
  }
  const keys = [...weeks.keys()].sort();
  if (keys.length < 2) return null;
  const prior = weeks.get(keys[keys.length - 2]);
  return prior ? { high: prior.high, low: prior.low, close: prior.close } : null;
}

/**
 * Current trading date and whether its regular session has closed, evaluated in
 * US market time (America/New_York) so pivot selection can tell a still-forming
 * current-session bar from a completed one. DST-safe via Intl.
 *
 * We have no market-status feed inside this pure function (it is shared by the
 * cron and the on-demand rebuild, neither of which threads live session state
 * in), so we use the regular-session close time as the completeness boundary:
 *   - The regular NYSE/Nasdaq session closes at 16:00 ET. A bar dated for the
 *     current ET calendar day is treated as complete only once 16:00 ET has
 *     passed; before that it is a still-forming intraday aggregate and the prior
 *     bar is the last completed session.
 *   - This is CORRECT for the two common cases: mid-session → prior day;
 *     after the close (still the same calendar day) → today's completed bar.
 * Documented tradeoff: early-close half-days (13:00 ET) are conservatively
 * treated as still-open until 16:00 ET, so between 13:00 and 16:00 on those days
 * the basis falls back to the prior completed session rather than the (already
 * finished) half-day — the safe direction, never a partial bar.
 */
function marketTimeEt(now: Date): {
  etDate: string;
  regularSessionClosed: boolean;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const etDate = `${get("year")}-${get("month")}-${get("day")}`;
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // some engines emit "24" for midnight
  // Regular session close is 16:00 ET.
  const regularSessionClosed = hour >= 16;
  return { etDate, regularSessionClosed };
}

/**
 * Annualized N-day realized (historical) volatility, as a percent. Sample
 * standard deviation of daily log returns over the window, scaled by √252.
 * This is what the "30d Vol" column shows — a real volatility measure computed
 * from the bars, since no implied-volatility (options) feed is on the plan.
 */
function realizedVol(closes: number[], window = 30): number | null {
  if (closes.length < window + 1) return null;
  const slice = closes.slice(-(window + 1));
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1] > 0 && slice[i] > 0) rets.push(Math.log(slice[i] / slice[i - 1]));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/** Bar shape the indicator math consumes — ascending by date. */
export interface IndicatorBar {
  barDate?: string;
  open?: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number | null;
}

/**
 * Pure technical-indicator computation, shared by the nightly sweep
 * (computeFor below) and the on-demand first-time company sync
 * (ondemand.service.getCompany) so a ticker seen for the very first time carries
 * the SAME technical field set the cron writes — RSI/MACD/Stoch/ADX, beta, the
 * MA ladder, the rolling 52-week range and pivot key levels. `bars` must be
 * ascending by date and already limited to the window to analyse; `mktByDate` is
 * SPY closes keyed by barDate (the beta benchmark). Returns null when history is
 * too thin, matching the cron's skip so a sparse ticker degrades identically on
 * both paths.
 */
/**
 * Drop everything up to and including the most recent EXTREME single-day price
 * discontinuity. A spin-off or ticker reuse leaves such a gap (e.g. Western
 * Digital ~$1,500 → SanDisk ~$45 when SNDK was carved out) that Polygon's
 * split/dividend adjustment does NOT remove, so the prior entity's prices poison
 * the 52-week range and pivots. A gradual crash never produces a single-day
 * >90%-down / >900%-up move, and no genuine session does either — so this leaves
 * every normal ticker's series byte-identical and only trims true structural
 * breaks. Uses close-to-close ratios (already split-adjusted).
 */
function trimAtStructuralBreak(bars: IndicatorBar[]): IndicatorBar[] {
  let start = 0;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (prev > 0 && cur > 0) {
      const ratio = cur / prev;
      if (ratio > 10 || ratio < 0.1) start = i;
    }
  }
  return start > 0 ? bars.slice(start) : bars;
}

export function computeIndicators(
  inputBars: IndicatorBar[],
  mktByDate: Map<string, number>,
  now: Date = new Date(),
  // OFFICIAL 16:00 regular-session close keyed by barDate, supplied by callers to
  // correct the keyLevels.daily pivot basis (Polygon's daily aggregate close is
  // the extended-hours last trade). Optional and backward-compatible: when
  // absent, every output — keyLevels.daily included — is byte-identical to before.
  officialCloseByDate?: Map<string, number>,
) {
  // Remove pre-spin-off / pre-ticker-reuse bars before any computation so the
  // 52-week range, pivots and MAs are all built from one continuous entity.
  const bars = trimAtStructuralBreak(inputBars);
  if (bars.length < MIN_BARS) return null;
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const rsiVal = rsi(closes);
  const macdVal = macd(closes);
  if (rsiVal == null || macdVal == null) return null;
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const week5ChangePct = changeOverSessions(closes, 5);
  // The close the 5-day move is measured FROM, stored alongside the move itself.
  //
  // week5ChangePct ends at the last stored bar, which can be days old — DAIC
  // read +1258% from a close two sessions back, beside a live price that had
  // since fallen ~37%. Publishing the base lets the reader measure the same
  // window to the price it is actually showing, so the figure describes the
  // number next to it. Null whenever the move is null, so the two travel
  // together and a caller cannot mix a fresh base with a stale move.
  const week5BaseClose =
    week5ChangePct == null ? null : (closes[closes.length - 1 - 5] ?? null);
  const latestClose = closes[closes.length - 1];

  // 52-week range from the real rolling year of highs/lows.
  const yearHighs = highs.slice(-TRADING_DAYS_YEAR);
  const yearLows = lows.slice(-TRADING_DAYS_YEAR);
  const high52 = yearHighs.length > 0 ? Math.max(...yearHighs) : null;
  const low52 = yearLows.length > 0 ? Math.min(...yearLows) : null;

  // Full MA ladder for the drawer; sma50/sma200 stay as their own fields too.
  const smaLadder: Record<string, number | null> = {};
  const emaLadder: Record<string, number | null> = {};
  for (const p of MA_PERIODS) {
    smaLadder[String(p)] = round2(sma(closes, p));
    const e = closes.length >= p ? ema(closes, p)[closes.length - 1] : null;
    emaLadder[String(p)] = round2(e);
  }

  const latestBar = bars[bars.length - 1];

  // Pivot basis = the last FULLY-COMPLETED daily session, never a still-forming
  // current-day bar. The last bar is only current-and-open when it is dated for
  // today's ET session AND the 16:00 ET close has not passed; in that window the
  // prior bar is the last completed session. After the close (or on any past
  // calendar day), the last bar is itself a completed session. This excludes the
  // partial current-day bar the on-demand rebuild fetches mid-session (it pulls
  // Polygon aggs through `now`), so keyLevels never mix a live/partial close.
  // NOTE: `latestBar` (and `latestClose` above) intentionally stay the raw last
  // bar — VWAP and price-vs-MA reads want the current session, only the pivot
  // BASIS must be a completed session.
  const { etDate, regularSessionClosed } = marketTimeEt(now);
  const lastIsCurrentOpenSession =
    latestBar?.barDate === etDate && !regularSessionClosed;
  const completedBars = lastIsCurrentOpenSession ? bars.slice(0, -1) : bars;
  const pivotBasisBar = completedBars[completedBars.length - 1];

  const rsiHistory = rsiSeries(closes).slice(-RSI_SERIES_LEN);
  const stochKVal = stochK(highs, lows, closes);
  const adxVal = adx(highs, lows, closes);
  const betaVal = betaVs(
    bars as { barDate: string; close: number }[],
    mktByDate,
  );

  return {
    rsi14: Math.round(rsiVal * 100) / 100,
    stochK: stochKVal == null ? null : Math.round(stochKVal * 100) / 100,
    adx14: adxVal == null ? null : Math.round(adxVal * 100) / 100,
    beta: betaVal == null ? null : Math.round(betaVal * 1000) / 1000,
    macd: Math.round(macdVal.macd * 10000) / 10000,
    macdSignal: Math.round(macdVal.signal * 10000) / 10000,
    macdHistogram: Math.round(macdVal.histogram * 10000) / 10000,
    rvol: (() => {
      const v = rvol(volumes);
      return v == null ? null : Math.round(v * 100) / 100;
    })(),
    sma50: sma50 == null ? null : Math.round(sma50 * 100) / 100,
    sma200: sma200 == null ? null : Math.round(sma200 * 100) / 100,
    aboveSma50: sma50 == null ? null : latestClose >= sma50,
    aboveSma200: sma200 == null ? null : latestClose >= sma200,
    week5ChangePct:
      week5ChangePct == null ? null : Math.round(week5ChangePct * 100) / 100,
    week5BaseClose:
      week5BaseClose == null ? null : Math.round(week5BaseClose * 10000) / 10000,

    /** Rolling RSI(14) line for the RSI pane. */
    rsi14Series: rsiHistory.map((v) => Math.round(v * 10) / 10),
    /** SMA/EMA at every period the MA drawer lists, keyed by period. */
    smaLadder,
    emaLadder,
    /** Session VWAP straight from the vendor bar. */
    vwap: round2(latestBar?.vwap),
    /** Real rolling-52-week range and where price sits inside it. */
    high52,
    low52,
    pctFromHigh52:
      high52 && high52 > 0
        ? round2(((latestClose - high52) / high52) * 100)
        : null,
    pctFromLow52:
      low52 && low52 > 0
        ? round2(((latestClose - low52) / low52) * 100)
        : null,
    /** Average daily volume. */
    avgVolume20: round2(trailingAvg(volumes, 20)),
    avgVolume50: round2(trailingAvg(volumes, 50)),
    /** Bars actually used, so the UI can tell "no data" from "thin history". */
    barsAnalyzed: closes.length,

    /** Annualized 30-day realized volatility (%) — the "30d Vol" column (there
     *  is no implied-vol/options feed on the plan). */
    realizedVol30: (() => {
      const v = realizedVol(closes, 30);
      return v == null ? null : Math.round(v * 100) / 100;
    })(),

    /**
     * Support & resistance — classic pivot points from the prior daily and
     * prior-complete-weekly bar (Polygon has no S/R feed).
     */
    keyLevels: {
      // Daily classic pivots from the last COMPLETED session (pivotBasisBar),
      // using that bar's stored/finalized OHLC — never a partial current-day bar
      // and never a substituted live price for the close.
      daily: (() => {
        if (
          !pivotBasisBar ||
          typeof pivotBasisBar.high !== "number" ||
          typeof pivotBasisBar.low !== "number" ||
          typeof pivotBasisBar.close !== "number"
        ) {
          return null;
        }
        // Prefer the OFFICIAL 16:00 regular-session close for the pivot CLOSE when
        // the caller supplied one for this bar's date; Polygon's stored daily
        // close is the extended-hours last trade, which skews the pivot. Falls
        // back to the stored close when absent/null (zero-regression). Weekly
        // pivots below could be corrected the same way later — intentionally left
        // untouched in this zero-side-effect pass.
        const pivotClose =
          (pivotBasisBar.barDate != null
            ? officialCloseByDate?.get(pivotBasisBar.barDate)
            : undefined) ?? pivotBasisBar.close;
        return pivotLevels(pivotBasisBar.high, pivotBasisBar.low, pivotClose);
      })(),
      // Weekly pivots from the last COMPLETE week. priorWeekHLC already returns
      // the second-to-last week bucket (excluding the current in-progress week);
      // feeding it `completedBars` also keeps a still-forming current-day bar out
      // of the week aggregation so its H/L/C can never leak into the basis.
      weekly: (() => {
        const w = priorWeekHLC(
          completedBars as Array<{
            barDate?: string;
            high?: number;
            low?: number;
            close?: number;
          }>,
        );
        return w ? pivotLevels(w.high, w.low, w.close) : null;
      })(),
    },
  };
}

@Injectable()
export class TechnicalIndicatorsJob implements OnModuleInit {
  private readonly logger = new Logger(TechnicalIndicatorsJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly polygon: PolygonService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["companies"],
      cronExpression: "10 4 * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  /** SPY closes keyed by barDate — the benchmark for beta. */
  private async loadMarketCloses(): Promise<Map<string, number>> {
    const snap = await this.firebase.firestore
      .collection("ohlcv_bars")
      .where("ticker", "==", "SPY")
      .orderBy("barDate", "desc")
      .limit(BARS_TO_READ)
      .get();
    const m = new Map<string, number>();
    for (const d of snap.docs) {
      const x = d.data();
      if (typeof x.close === "number") m.set(x.barDate as string, x.close);
    }
    return m;
  }

  private async computeFor(ticker: string, mktByDate: Map<string, number>) {
    const snap = await this.firebase.firestore
      .collection("ohlcv_bars")
      .where("ticker", "==", ticker)
      .orderBy("barDate", "desc")
      .limit(BARS_TO_READ)
      .get();
    const bars = snap.docs.map((d) => d.data()).reverse() as IndicatorBar[];
    // OFFICIAL 16:00 close for the classic-pivot basis only. The pivot basis is
    // the last completed daily session; fetch the official close for the last 1–2
    // bar dates (the possible basis dates) and pass only non-null results — any
    // miss / weekend / holiday leaves the map empty and the pivot falls back to
    // the stored bar close (no regression). Not fetched for historical bars.
    const officialCloseByDate = await this.officialCloseMapFor(ticker, bars);
    return computeIndicators(bars, mktByDate, undefined, officialCloseByDate);
  }

  /**
   * Build the pivot-basis official-close map: at most the last two ascending bar
   * dates, each looked up via Polygon's official (regular-session) close. Only
   * non-null lookups are added, so an empty map (all failed / no dates) makes
   * computeIndicators fall back to the stored daily close. 1–2 calls per build.
   */
  private async officialCloseMapFor(
    ticker: string,
    bars: IndicatorBar[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for (const b of bars.slice(-2)) {
      if (!b.barDate) continue;
      const oc = await this.polygon.getOfficialClose(ticker, b.barDate);
      if (oc != null) map.set(b.barDate, oc);
    }
    return map;
  }

  async run() {
    try {
      // Dynamic universe: exactly the tickers users have touched (on-demand
      // growth) plus the premarket warm set — never the fixed list.
      const universe = await activeUniverse(this.firebase.firestore);
      if (universe.length === 0) {
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { computed: 0, skipped: 0, note: "no active tickers yet" };
      }
      const mktByDate = await this.loadMarketCloses();
      const results = [];
      let skipped = 0;
      for (const ticker of universe) {
        try {
          const ind = await this.computeFor(ticker, mktByDate);
          if (!ind) {
            skipped++;
            continue;
          }
          results.push({
            ticker,
            data: { ...ind, technicalsUpdatedAt: new Date().toISOString() },
          });
        } catch (err) {
          this.logger.error(
            `Failed computing indicators for ${ticker}: ${err.message}`,
          );
          skipped++;
        }
      }
      if (results.length === 0) {
        this.logger.warn(
          `No tickers had enough ohlcv_bars to compute indicators (${skipped}/${universe.length} skipped) — has stock-history.job.ts run yet?`,
        );
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { computed: 0, skipped };
      }
      const writes: PendingWrite[] = [];
      const col = this.firebase.firestore.collection("companies");
      for (const r of results) {
        writes.push({ ref: col.doc(r.ticker), data: r.data });
      }
      await batchSetWithCreatedAt(this.firebase.firestore, writes);
      await this.meta.record(JOB_NAME, { ok: true, count: results.length });
      return { computed: results.length, skipped };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
