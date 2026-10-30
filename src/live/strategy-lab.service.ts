import { Injectable, Logger } from "@nestjs/common";
import { FmpService } from "../vendors/fmp/fmp.service";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import {
  fromFmpSymbol,
  toFmpSymbol,
} from "../vendors/market-data/fmp-mapping.util";

/** One bar: [date, open, high, low, close, volume] — compact for the wire. */
export type LabBar = [string, number, number, number, number, number];

/** Strategy Lab candle sizes served from FMP's intraday chart. */
export const LAB_INTRADAY: Record<string, string> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "30m": "30min",
  "1h": "1hour",
  "4h": "4hour",
};

const DAY = 86_400_000;
const DAILY_TTL_MS = 6 * 3_600_000;
const UNIVERSE_TTL_MS = 12 * 3_600_000;
/** Stocks in the Strategy Lab test universe: the largest S&P 500 constituents by market cap. */
export const LAB_UNIVERSE_SIZE = 50;
const INTRADAY_TTL_MS = 5 * 60_000;
/** Safety cap on backwards paging for one intraday request. */
const MAX_PAGES = 40;

const etDay = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
    new Date(ms),
  );

/**
 * The indicator catalogue the Strategy Lab engine (UI: app/iq/sl/engine.js)
 * understands, for the rule-builder prompt. Mirrors its `IND` table — keep the
 * two in step when an indicator is added.
 */
const IND_SCHEMA = [
  "close = Close",
  "open = Open",
  "high = High",
  "low = Low",
  "volume = Volume",
  "sma = SMA (period n, default 50)",
  "ema = EMA (period n, default 21)",
  "rsi = RSI (period n, default 14)",
  "roc = Rate of change % (period n, default 10)",
  "atr = ATR (period n, default 14)",
  "hh = Highest close (period n, default 252)",
  "ll = Lowest close (period n, default 252)",
  "avgvol = Avg volume (period n, default 50)",
  "bbu = Bollinger upper (2σ) (period n, default 20)",
  "bbl = Bollinger lower (2σ) (period n, default 20)",
  "sqz = Squeeze (width at N-bar low) (period n, default 126)",
  "macd = MACD (12,26)",
  "macds = MACD signal (9)",
  "bars = Bars in trade [exit only]",
  "num = Number",
  "vwap = VWAP (session)",
  "orh = Opening-range high (first N bars) (period n, default 6)",
  "orl = Opening-range low (first N bars) (period n, default 6)",
  "pdh = Prior-day high",
  "pdl = Prior-day low",
  "pdc = Prior-day close",
  "dayopen = Today's open",
  "tod = Minutes since 9:30 open",
  "eps_surprise = EPS surprise % [not runnable yet]",
  "gap = Opening gap %",
  "days_er = Days since earnings [not runnable yet]",
  "mom_rank = 12-1M return rank [not runnable yet]",
].join("\n");
const OPS = [">", "<", "≥", "≤", "crosses above", "crosses below"];

/**
 * FMP bars + AI for Strategy Lab. Bars are split-adjusted daily EOD or the
 * intraday chart restricted to the regular session. Serves single-stock bars
 * to the browser (cached per instance) and the uncached fetchers the Strategy
 * Lab jobs build their stored bar packs from.
 */
@Injectable()
export class StrategyLabService {
  private readonly logger = new Logger(StrategyLabService.name);
  private readonly cache = new Map<string, { rows: LabBar[]; at: number }>();
  private readonly inflight = new Map<string, Promise<LabBar[]>>();
  private universeMem: {
    at: number;
    value: {
      asOf: string;
      source: string;
      stocks: Array<{ t: string; n: string; marketCap: number }>;
    };
  } | null = null;

  constructor(
    private readonly fmp: FmpService,
    private readonly llm: LlmGatewayService,
  ) {}

  /**
   * The test universe: the LAB_UNIVERSE_SIZE largest S&P 500 constituents by
   * market cap (FMP constituents + FMP quotes), cached for 12 hours. Throws
   * when FMP can't supply it — the caller shows the error, never a fallback list.
   */
  async universe(): Promise<{
    asOf: string;
    source: string;
    stocks: Array<{ t: string; n: string; marketCap: number }>;
  }> {
    if (this.universeMem && Date.now() - this.universeMem.at < UNIVERSE_TTL_MS)
      return this.universeMem.value;
    const rows = (await this.fmp.request("sp500-constituent")) as Array<{
      symbol?: string;
      name?: string;
    }>;
    const names = new Map<string, string>();
    for (const r of rows)
      if (r?.symbol) names.set(r.symbol, r.name ?? r.symbol);
    const syms = [...names.keys()];
    if (!syms.length) throw new Error("FMP returned no S&P 500 constituents");
    const caps: Array<{ t: string; n: string; marketCap: number }> = [];
    for (let i = 0; i < syms.length; i += 100) {
      for (const q of await this.fmp.getQuotes(syms.slice(i, i + 100))) {
        const mc = Number(q.marketCap);
        if (Number.isFinite(mc) && mc > 0)
          caps.push({
            t: fromFmpSymbol(q.symbol),
            n: names.get(q.symbol) ?? q.symbol,
            marketCap: mc,
          });
      }
    }
    if (caps.length < LAB_UNIVERSE_SIZE)
      throw new Error(`FMP priced only ${caps.length} S&P 500 constituents`);
    caps.sort((a, b) => b.marketCap - a.marketCap);
    const value = {
      asOf: new Date().toISOString(),
      source: "FMP S&P 500 constituents ranked by market cap",
      stocks: caps.slice(0, LAB_UNIVERSE_SIZE),
    };
    this.universeMem = { at: Date.now(), value };
    return value;
  }

  /**
   * Bars for each symbol, ascending. `tf` "d" (daily, `years` back) or an
   * intraday key from LAB_INTRADAY (`days` back). Symbols FMP has nothing for
   * are reported in `missing` rather than failing the whole batch.
   */
  async bars(
    symbols: string[],
    tf: string,
    span: { years?: number; days?: number },
  ): Promise<{
    asOf: string | null;
    bars: Record<string, LabBar[]>;
    missing: string[];
  }> {
    const out: Record<string, LabBar[]> = {};
    const missing: string[] = [];
    const queue = [...symbols];
    const work = async () => {
      while (queue.length) {
        const sym = queue.shift() as string;
        try {
          const rows = await this.one(sym, tf, span);
          if (rows.length) out[sym] = rows;
          else missing.push(sym);
        } catch (err) {
          this.logger.warn(
            `bars ${sym} ${tf}: ${(err as Error)?.message ?? err}`,
          );
          missing.push(sym);
        }
      }
    };
    await Promise.all([work(), work(), work(), work()]);
    let asOf: string | null = null;
    for (const rows of Object.values(out)) {
      const last = rows[rows.length - 1]?.[0];
      if (last && (!asOf || last > asOf)) asOf = last;
    }
    return { asOf, bars: out, missing };
  }

  private one(
    sym: string,
    tf: string,
    span: { years?: number; days?: number },
  ): Promise<LabBar[]> {
    const intraday = LAB_INTRADAY[tf];
    const key = intraday
      ? `${sym}|${tf}|${span.days}`
      : `${sym}|d|${span.days != null ? span.days + "d" : span.years}|${etDay(Date.now())}`;
    const hit = this.cache.get(key);
    if (
      hit &&
      Date.now() - hit.at < (intraday ? INTRADAY_TTL_MS : DAILY_TTL_MS)
    )
      return Promise.resolve(hit.rows);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (
      intraday
        ? this.fetchIntraday(sym, intraday, span.days ?? 21)
        : this.fetchDaily(
            sym,
            span.days != null ? span.days / 365.25 : (span.years ?? 6),
          )
    )
      .then((rows) => {
        this.cache.set(key, { rows, at: Date.now() });
        return rows;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** FMP daily bars (split-adjusted), ascending, without today's unfinished session. Uncached. */
  async fetchDaily(sym: string, years: number): Promise<LabBar[]> {
    const now = Date.now();
    const from = etDay(now - Math.round(years * 365.25 * DAY));
    const rows = (await this.fmp.request(
      `historical-price-eod/full?symbol=${encodeURIComponent(toFmpSymbol(sym))}&from=${from}&to=${etDay(now)}`,
    )) as Array<Record<string, unknown>>;
    return dropUnfinishedDay(
      toBars(rows, (d) => d.slice(0, 10)),
      now,
    );
  }

  /**
   * FMP's intraday chart answers a limited number of bars per call (a 30-day
   * 5-min request returns ~7 sessions), so page backwards by moving `to`
   * before the earliest bar received until the window is covered.
   */
  async fetchIntraday(
    sym: string,
    interval: string,
    days: number,
  ): Promise<LabBar[]> {
    const now = Date.now();
    const from = etDay(now - days * DAY);
    let to = etDay(now);
    const seen = new Map<string, LabBar>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = (await this.fmp.request(
        `historical-chart/${interval}?symbol=${encodeURIComponent(toFmpSymbol(sym))}&from=${from}&to=${to}`,
      )) as Array<Record<string, unknown>>;
      const bars = toBars(rows, (d) => d.slice(0, 19));
      if (!bars.length) break;
      for (const b of bars) seen.set(b[0], b);
      const earliestDay = bars[0][0].slice(0, 10);
      if (earliestDay <= from) break;
      const next = etDay(Date.parse(`${earliestDay}T12:00:00Z`) - DAY);
      if (next >= to) break; // no progress
      to = next;
    }
    // Regular session only (09:30–16:00 ET), as the engine's session logic expects.
    return [...seen.values()]
      .filter((b) => {
        const t = b[0].slice(11, 16);
        return t >= "09:30" && t < "16:00";
      })
      .sort((a, b) => a[0].localeCompare(b[0]));
  }

  /**
   * Intraday bars from `fromDay` (ET date) to now — the incremental refresh a
   * stored pack needs. Pages like fetchIntraday, regular session only.
   */
  async fetchIntradaySince(
    sym: string,
    interval: string,
    fromDay: string,
  ): Promise<LabBar[]> {
    const days = Math.max(
      1,
      Math.ceil((Date.now() - Date.parse(`${fromDay}T00:00:00Z`)) / DAY),
    );
    return this.fetchIntraday(sym, interval, days);
  }

  /**
   * Plain-English description → rule-set JSON, via the LLM gateway. Same
   * instructions as the prototype's builder; the browser validates every
   * operand and falls back to its deterministic parser when this returns null.
   */
  async aiRules(q: string): Promise<string | null> {
    if (!this.llm.enabled) return null;
    const prompt =
      "You convert a trader's description into a long-only daily backtest rule set for US stocks.\n" +
      "Indicators (key = meaning):\n" +
      IND_SCHEMA +
      '\nnum = a constant (use {"ind":"num","v":number}).\nOperators: ' +
      OPS.join(" | ") +
      '\nOperand JSON: {"ind":key,"n":period?,"mult":multiplier?}. Percent values (roc, gap, eps_surprise) are in percent units.\n' +
      "All periods are counted in bars of the timeframe the trader names (e.g. on a 15-min chart, EMA 9 = 9 fifteen-minute bars); default is daily. " +
      'Entry conditions are ANDed; exit conditions are ORed. For an OR inside the entry, use one item {"any":[cond,cond]}. Use "bars" >= num for time exits. ' +
      "Prefer runnable indicators; only use a [not runnable yet] one if the description truly requires it.\n" +
      'Reply with ONLY JSON: {"name":"short name, max 5 words","entry":[{"a":operand,"op":op,"b":operand}],"exit":[...],"stop":fraction or null,"tp":fraction or null,"trail":fraction or null,"timeframe":"1m|5m|15m|30m|1h|4h|d|1w","why":"one sentence: what edge this targets"}\n' +
      "Description: " +
      q;
    try {
      return await this.llm.chat([{ role: "user", content: prompt }], {
        jsonMode: true,
        timeoutMs: 25_000,
        maxTokens: 900,
      });
    } catch (err) {
      this.logger.warn(`aiRules failed: ${(err as Error)?.message ?? err}`);
      return null;
    }
  }
}

/**
 * During the session FMP's daily feed already carries today's bar, priced at
 * the latest trade. The engine treats every daily bar as a finished close
 * (signals on the close of day t), so a half-formed day would fire signals on
 * prices that are not closes yet. It is dropped until 16:15 ET.
 */
export function dropUnfinishedDay(rows: LabBar[], now: number): LabBar[] {
  const last = rows[rows.length - 1];
  if (!last || last[0] !== etDay(now)) return rows;
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(now));
  return hm < "16:15" ? rows.slice(0, -1) : rows;
}

export function toBars(
  rows: Array<Record<string, unknown>>,
  date: (d: string) => string,
): LabBar[] {
  const out: LabBar[] = [];
  for (const r of rows ?? []) {
    const d = String(r.date ?? "");
    const o = Number(r.open),
      h = Number(r.high),
      l = Number(r.low),
      c = Number(r.close),
      v = Number(r.volume);
    if (!d || !(c > 0) || !(o > 0) || !(h > 0) || !(l > 0)) continue;
    out.push([date(d), o, h, l, c, Number.isFinite(v) ? v : 0]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}
