import * as Engine from "./engine";
import type { EngineBar } from "./bar-pack";

/**
 * One stock's universe-backtest row — what the prototype's runValidate kept
 * per stock and valVals derived from it, computed server-side so the browser
 * receives results instead of bars. Mirrors app/iq/sl/lab-controller.jsx.
 */

/** Return-window options (prototype MWIN / RWIN): minutes for 1–30-min candles, days otherwise. */
export const MWIN: Record<string, number[]> = {
  "1m": [5, 15, 30, 60, 120, 240, 390],
  "5m": [15, 30, 60, 120, 180, 240, 390],
  "15m": [30, 60, 90, 120, 180, 240, 390],
  "30m": [60, 90, 120, 180, 240, 300, 390],
};
export const RWIN: Record<string, number[]> = {
  d: [7, 14, 30, 60, 90, 180, 365],
  "1w": [30, 60, 90, 180, 365, 730, 1095],
  "1m": [1, 2, 3, 4, 5, 6, 7],
  "5m": [1, 2, 3, 7, 14, 21, 30],
  "15m": [1, 2, 7, 14, 30, 60, 90],
  "30m": [2, 7, 14, 30, 60, 90, 180],
  "1h": [7, 14, 30, 60, 90, 180, 365],
  "4h": [14, 30, 60, 90, 180, 365, 730],
};
/** Intraday backtest periods offered per candle (prototype IPER), in calendar days. */
export const IPER: Record<string, number[]> = {
  "1m": [1, 2, 5, 7],
  "5m": [7, 14, 21, 30],
  "15m": [14, 30, 60, 90],
  "30m": [30, 60, 90, 180],
  "1h": [30, 90, 180, 365],
  "4h": [90, 180, 365, 730],
};

/** Settings the universe backtest uses (prototype valCfg + intraday period). */
export interface RunCfg {
  stop: number;
  tp: number | null;
  trail: number | null;
  costBps: number;
  years: number;
  /** Intraday period in calendar days (candles with an FMP intraday feed). */
  idays?: number;
}

export type WindowStat = [a: number, b: number, n: number, w: number];

export interface UniverseRow {
  t: string;
  n: string;
  /** evalLast: "ready" / "setup" / null, bars since all entry rules were true. */
  st: "ready" | "setup" | null;
  ago: number | null;
  met: number;
  total: number;
  sh: number;
  cagr: number;
  bcagr: number;
  tot: number;
  trades: number;
  /** Per return-window option: [strategy return, buy & hold return, closed trades, winners]. */
  w: Record<string, WindowStat>;
}

export const tfInfo = (tf: string) =>
  (
    Engine.TF as Record<
      string,
      { l: string; fmp?: string; days?: number; flat?: boolean }
    >
  )[tf] ?? { l: "Daily" };
export const isMinuteTf = (tf: string) => !!tfInfo(tf).flat;
export const windowOpts = (tf: string) =>
  isMinuteTf(tf) ? (MWIN[tf] ?? MWIN["5m"]) : (RWIN[tf] ?? RWIN.d);

const minuteCut = (last: string, minutes: number): string => {
  if (minutes >= 390) return last.slice(0, 10);
  const t = new Date(`${last.slice(0, 10)}T${last.slice(11, 19)}Z`);
  t.setUTCMinutes(t.getUTCMinutes() - minutes);
  return t.toISOString().slice(0, 19).replace("T", " ");
};
const dayCut = (last: string, days: number): string => {
  const c = new Date(`${last.slice(0, 10)}T00:00:00Z`);
  c.setUTCDate(c.getUTCDate() - days);
  return c.toISOString().slice(0, 10);
};

/**
 * Window stats exactly as the prototype's wret/wstat for day windows. For
 * minute windows the prototype's version could not work — the engine folds an
 * intraday equity curve to one point per day, so a 60-minute cut-off had no
 * points to land on (and its date parse threw) — so those use bar timestamps:
 * buy & hold from the bars, the strategy from the trades in the window
 * (closed ones at their exit, an open one marked to the last close).
 */
export function windowStats(
  r: any,
  bars: EngineBar[],
  tf: string,
): Record<string, WindowStat> {
  const out: Record<string, WindowStat> = {};
  const closed = r.trades.filter((t: any) => t.why !== "Still open");
  const minute = isMinuteTf(tf);
  for (const rw of windowOpts(tf)) {
    if (!minute) {
      const cs = dayCut(r.eq[r.eq.length - 1].date, rw);
      const wret = (eq: any[]) => {
        const L = eq[eq.length - 1];
        const s0 = eq.find((x) => x.date.slice(0, 10) >= cs) || eq[0];
        return L.v / s0.v - 1;
      };
      const cl = closed.filter(
        (t: any) => String(t.outDate).slice(0, 10) >= cs,
      );
      out[rw] = [
        wret(r.eq),
        wret(r.bh),
        cl.length,
        cl.filter((t: any) => t.ret > 0).length,
      ];
      continue;
    }
    const last = bars[bars.length - 1];
    const cs = minuteCut(last.date, rw);
    const k0 = bars.findIndex(
      (b) => (rw >= 390 ? b.date.slice(0, 10) : b.date) >= cs,
    );
    const base = bars[Math.max(0, k0 - 1)];
    const bh = base ? last.close / base.close - 1 : 0;
    const inWin = r.trades.filter((t: any) => String(t.outDate) >= cs);
    const strat = inWin.reduce((a: number, t: any) => a * (1 + t.ret), 1) - 1;
    const cl = inWin.filter((t: any) => t.why !== "Still open");
    out[rw] = [strat, bh, cl.length, cl.filter((t: any) => t.ret > 0).length];
  }
  return out;
}

/**
 * Backtest + live-signal scan for one stock, as the prototype's runValidate
 * worker loop: weekly bars are folded from daily; daily runs start `years`
 * before the last bar; intraday runs flatten at the session close when the
 * candle is ≤ 30 minutes. Null when the engine has too little history.
 */
export function runOne(
  t: string,
  name: string,
  bars: EngineBar[],
  spec: any,
  tf: string,
  cfg: RunCfg,
): UniverseRow | null {
  const T = tfInfo(tf);
  const b = tf === "1w" ? Engine.toWeekly(bars) : bars;
  if (!b.length) return null;
  const c: Record<string, unknown> = {
    stop: cfg.stop,
    tp: cfg.tp,
    trail: cfg.trail,
    costBps: cfg.costBps,
    years: cfg.years,
  };
  if (T.fmp) {
    c.intraday = true;
    c.flatEOD = T.flat;
  } else {
    const d = new Date(b[b.length - 1].date);
    d.setFullYear(d.getFullYear() - (cfg.years || 5));
    c.startDate = d.toISOString().slice(0, 10);
  }
  const r = Engine.runRules(b, spec, c);
  if (!r) return null;
  const ev = Engine.evalLast(b, spec, T.fmp ? 6 : tf === "1w" ? 2 : 5);
  return {
    t,
    n: name,
    st: (ev?.status ?? null) as UniverseRow["st"],
    ago: ev?.ago ?? null,
    met: ev?.met ?? 0,
    total: ev?.total ?? 0,
    sh: r.m.sharpe,
    cagr: r.m.cagr,
    bcagr: r.mb.cagr,
    tot: r.m.tot,
    trades: r.m.trades,
    w: windowStats(r, b, tf),
  };
}

/** Engine rule check (indicators needing non-price data, empty entry …). */
export const ruleProblems = (spec: any): string[] =>
  Engine.checkRules(spec) as string[];
