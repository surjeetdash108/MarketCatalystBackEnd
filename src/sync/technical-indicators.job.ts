import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { batchSetWithCreatedAt, type PendingWrite } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { activeUniverse } from '../common/ticker-universe';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'technical-indicators';
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
  if (closes.length < period + 1)
    return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0)
      gain += d;
    else
      loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0)
    return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Stochastic %K over `period` — where the last close sits in the period range. */
function stochK(highs: number[], lows: number[], closes: number[], period = 14): number | null {
  if (closes.length < period) return null;
  const hh = Math.max(...highs.slice(-period));
  const ll = Math.min(...lows.slice(-period));
  const c = closes[closes.length - 1];
  if (!Number.isFinite(hh) || !Number.isFinite(ll) || hh === ll) return null;
  return ((c - ll) / (hh - ll)) * 100;
}

/** Wilder ADX(14) — trend strength from smoothed +DI/-DI. */
function adx(highs: number[], lows: number[], closes: number[], period = 14): number | null {
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
    if (trS[i] === 0) { dx.push(0); continue; }
    const pdi = (100 * pS[i]) / trS[i];
    const mdi = (100 * mS[i]) / trS[i];
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum);
  }
  if (dx.length < period) return null;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adxVal = (adxVal * (period - 1) + dx[i]) / period;
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
    if (s == null || sPrev == null || sPrev <= 0 || cPrev == null || cPrev <= 0 || c == null) continue;
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
  if (closes.length < 35)
    return null;
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
  if (volumes.length < window + 1)
    return null;
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
  const out: number[] = [avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)];
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

@Injectable()
export class TechnicalIndicatorsJob implements OnModuleInit {
  private readonly logger = new Logger(TechnicalIndicatorsJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['companies'],
      cronExpression: '10 4 * * *',
      timeZone: 'America/New_York',
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  /** SPY closes keyed by barDate — the benchmark for beta. */
  private async loadMarketCloses(): Promise<Map<string, number>> {
    const snap = await this.firebase.firestore
      .collection('ohlcv_bars')
      .where('ticker', '==', 'SPY')
      .orderBy('barDate', 'desc')
      .limit(BARS_TO_READ)
      .get();
    const m = new Map<string, number>();
    for (const d of snap.docs) {
      const x = d.data();
      if (typeof x.close === 'number') m.set(x.barDate as string, x.close);
    }
    return m;
  }

  private async computeFor(ticker: string, mktByDate: Map<string, number>) {
    const snap = await this.firebase.firestore
      .collection('ohlcv_bars')
      .where('ticker', '==', ticker)
      .orderBy('barDate', 'desc')
      .limit(BARS_TO_READ)
      .get();
    if (snap.size < MIN_BARS)
      return null;
    const bars = snap.docs.map((d) => d.data()).reverse();
    const closes = bars.map((b) => b.close);
    const volumes = bars.map((b) => b.volume);
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const rsiVal = rsi(closes);
    const macdVal = macd(closes);
    if (rsiVal == null || macdVal == null)
      return null;
    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const week5ChangePct = changeOverSessions(closes, 5);
    const latestClose = closes[closes.length - 1];

    // 52-week range from the real rolling year of highs/lows. The keystats tile
    // and the key-levels drawer previously derived these as fixed multiples of
    // the current price (px * 1.28 / px * 0.72), which is not a 52-week range at
    // all — it is the current price wearing one.
    const yearHighs = highs.slice(-TRADING_DAYS_YEAR);
    const yearLows = lows.slice(-TRADING_DAYS_YEAR);
    const high52 = yearHighs.length > 0 ? Math.max(...yearHighs) : null;
    const low52 = yearLows.length > 0 ? Math.min(...yearLows) : null;

    // Full MA ladder for the drawer. sma50/sma200 below are kept as their own
    // fields because existing screens (Movers, Heatmap, Tech Rating) read them
    // by name; the ladder is additive rather than a replacement.
    const smaLadder: Record<string, number | null> = {};
    const emaLadder: Record<string, number | null> = {};
    for (const p of MA_PERIODS) {
      smaLadder[String(p)] = round2(sma(closes, p));
      const e = closes.length >= p ? ema(closes, p)[closes.length - 1] : null;
      emaLadder[String(p)] = round2(e);
    }

    const latestBar = bars[bars.length - 1];
    const rsiHistory = rsiSeries(closes).slice(-RSI_SERIES_LEN);
    const stochKVal = stochK(highs, lows, closes);
    const adxVal = adx(highs, lows, closes);
    const betaVal = betaVs(bars as { barDate: string; close: number }[], mktByDate);

    return {
      rsi14: Math.round(rsiVal * 100) / 100,
      // Stochastic %K, Wilder ADX(14) and beta vs SPY — computed from the same
      // bars as RSI/MACD (previously rendered N/A for lack of a "technicals vendor").
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
      // Real MA context for the Movers table (was fabricated from the sign of
      // the day's move). Rounded to 2dp; null when history is too short.
      sma50: sma50 == null ? null : Math.round(sma50 * 100) / 100,
      sma200: sma200 == null ? null : Math.round(sma200 * 100) / 100,
      // Where price sits vs each MA, precomputed so the client needn't refetch bars.
      aboveSma50: sma50 == null ? null : latestClose >= sma50,
      aboveSma200: sma200 == null ? null : latestClose >= sma200,
      // True 5-session change — replaces the movers "week %" that reused the day move.
      week5ChangePct: week5ChangePct == null ? null : Math.round(week5ChangePct * 100) / 100,

      // ── Fields below replace values the UI was fabricating ──

      /** Rolling RSI(14) line for the RSI pane (was a seeded sine walk). */
      rsi14Series: rsiHistory.map((v) => Math.round(v * 10) / 10),
      /** SMA/EMA at every period the MA drawer lists, keyed by period. */
      smaLadder,
      emaLadder,
      /** Session VWAP straight from the vendor bar (was a price multiple). */
      vwap: round2(latestBar?.vwap),
      /** Real rolling-52-week range and where price sits inside it. */
      high52,
      low52,
      pctFromHigh52:
        high52 && high52 > 0 ? round2(((latestClose - high52) / high52) * 100) : null,
      pctFromLow52:
        low52 && low52 > 0 ? round2(((latestClose - low52) / low52) * 100) : null,
      /** Average daily volume — the keystats tile derived this from a formula. */
      avgVolume20: round2(trailingAvg(volumes, 20)),
      avgVolume50: round2(trailingAvg(volumes, 50)),
      /** Bars actually used, so the UI can tell "no data" from "thin history". */
      barsAnalyzed: closes.length,
    };
  }

  async run() {
    try {
      // Dynamic universe: exactly the tickers users have touched (on-demand
      // growth) plus the premarket warm set — never the fixed list.
      const universe = await activeUniverse(this.firebase.firestore);
      if (universe.length === 0) {
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { computed: 0, skipped: 0, note: 'no active tickers yet' };
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
          this.logger.error(`Failed computing indicators for ${ticker}: ${err.message}`);
          skipped++;
        }
      }
      if (results.length === 0) {
        this.logger.warn(`No tickers had enough ohlcv_bars to compute indicators (${skipped}/${universe.length} skipped) — has stock-history.job.ts run yet?`);
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { computed: 0, skipped };
      }
      const writes: PendingWrite[] = [];
      const col = this.firebase.firestore.collection('companies');
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
