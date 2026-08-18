import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchJson, type FetchJsonOptions } from "../../common/http.util";

/**
 * Financial Modeling Prep (FMP) — a SUPPLEMENTARY vendor, wired only for the
 * data Polygon structurally cannot provide (earnings estimates/surprises,
 * analyst ratings) plus optional sector performance. It NEVER supplies
 * price/OHLCV/snapshot/news/corporate actions — those stay Polygon-owned so
 * there is a single source of truth for price.
 *
 * Uses FMP's current `/stable/` API (the legacy `/api/v3` + `/api/v4` paths are
 * deprecated and now return 403). Auth is a `?apikey=` query param (redacted in
 * logs by http.util). Responses are parsed defensively — a field the plan/
 * version names differently degrades to null rather than throwing.
 *
 * Every FMP feature is opt-in behind a `<DOMAIN>_SOURCE` env var that defaults
 * to "none" (off). To remove FMP entirely: set every `*_SOURCE` back to "none",
 * then delete `src/vendors/fmp/` and the FMP adapters.
 */

const DEFAULT_BASE_URL = "https://financialmodelingprep.com/stable";

// Parses a vendor field to a finite number, else null. The old
// `Number(v) || null` had two data bugs: it turned a legitimate 0 into null
// (0 is falsy) — so a real "0 analysts" / "$0 estimate" vanished — and it let
// Infinity through (`Number("Infinity") || null` === Infinity). This preserves
// 0 and negatives, and rejects NaN/±Infinity.
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Normalised earnings-calendar row (per report date, all companies). */
export interface FmpEarningRow {
  date: string;
  symbol: string;
  epsEstimated: number | null;
  revenueEstimated: number | null;
  // Reported actuals (present once a company has announced) — the announcement
  // date fills the ~2-week gap Polygon's 10-Q filing-date feed leaves.
  epsActual: number | null;
  revenueActual: number | null;
}

/** Normalised stock-news row (`/stable/news/stock`). `site` is the outlet. */
export interface FmpNewsRow {
  symbol: string | null;
  publishedDate: string;
  title: string;
  text: string | null;
  site: string | null;
  url: string;
  image: string | null;
  /** Sentiment label when the response carries one, else null. */
  sentiment: string | null;
}

/** Normalised analyst grades consensus (rating tallies + label). */
export interface FmpConsensusRow {
  symbol: string;
  strongBuy: number | null;
  buy: number | null;
  hold: number | null;
  sell: number | null;
  strongSell: number | null;
  consensus: string | null;
}

/** Normalised sector performance (one row per sector). */
export interface FmpSectorPerformanceRow {
  sector: string;
  changesPercentage: string | number | null;
}

/** Normalised forward annual estimate (avg EPS/revenue per fiscal year). */
export interface FmpAnalystEstimateRow {
  date: string;
  symbol: string;
  estimatedEpsAvg: number | null;
  estimatedRevenueAvg: number | null;
}

/** Normalised per-ticker earnings history row (actual vs estimate). */
export interface FmpEarningsSurpriseRow {
  date: string;
  symbol: string;
  actualEarningResult: number | null;
  estimatedEarning: number | null;
}

/** Analyst price-target consensus (high/low/avg/median across firms). */
export interface FmpPriceTargetConsensusRow {
  targetHigh: number | null;
  targetLow: number | null;
  targetConsensus: number | null;
  targetMedian: number | null;
}

/** Rolling average price target over recent windows (trend). */
export interface FmpPriceTargetSummaryRow {
  lastMonthCount: number | null;
  lastMonthAvg: number | null;
  lastQuarterCount: number | null;
  lastQuarterAvg: number | null;
  lastYearCount: number | null;
  lastYearAvg: number | null;
}

/** A single per-firm rating change (upgrade/downgrade/initiate/maintain). */
export interface FmpGradeRow {
  date: string;
  gradingCompany: string | null;
  previousGrade: string | null;
  newGrade: string | null;
  action: string | null;
}

/** One firm's price-target post (`/stable/price-target-news`) — the per-analyst
 * target, keyed by the issuing firm. Used to give each grade its OWN target
 * instead of repeating the ticker's consensus across every firm. */
export interface FmpPriceTargetRow {
  date: string;
  firm: string | null;
  priceTarget: number | null;
}

/** A macro/economic-calendar release (past or scheduled). */
export interface FmpEconEventRow {
  date: string;
  country: string | null;
  event: string | null;
  currency: string | null;
  previous: number | null;
  estimate: number | null;
  actual: number | null;
  impact: string | null;
  unit: string | null;
}

/** One earnings-call transcript (`/stable/earning-call-transcript`). */
export interface FmpTranscriptRow {
  symbol: string;
  /** Fiscal quarter number, 1-4 (FMP's `period`/`quarter` field). */
  quarter: number | null;
  year: number | null;
  /** Call date (YYYY-MM-DD, sometimes with a time component). */
  date: string | null;
  /** Full transcript text — operator intro, prepared remarks and Q&A. */
  content: string;
}

/** Available (year, quarter) a transcript exists for (`/stable/earning-call-transcript-dates`). */
export interface FmpTranscriptDate {
  quarter: number | null;
  year: number | null;
  date: string | null;
}

/**
 * Per-ticker institutional (13F) ownership summary for one fiscal quarter
 * (`/stable/institutional-ownership/symbol-positions-summary`). This is the
 * ticker-indexed rollup SEC 13F (CUSIP-keyed) cannot give directly.
 */
export interface FmpInstitutionalOwnershipRow {
  symbol: string;
  year: number | null;
  quarter: number | null;
  /** Number of institutions holding the stock this quarter. */
  investorsHolding: number | null;
  /** Prior-quarter holder count. */
  lastInvestorsHolding: number | null;
  /** Net change in holder count QoQ (holders added − removed). */
  investorsHoldingChange: number | null;
  /** Total 13F shares held. */
  numberOf13Fshares: number | null;
  lastNumberOf13Fshares: number | null;
  /** Net change in shares held QoQ. */
  numberOf13FsharesChange: number | null;
  /** Total dollars invested across all 13F holders. */
  totalInvested: number | null;
  /** Percent of shares outstanding held by institutions (0-100). */
  ownershipPercent: number | null;
  /** Aggregate put/call ratio across holders (sentiment tilt). */
  putCallRatio: number | null;
}

@Injectable()
export class FmpService {
  private readonly logger = new Logger(FmpService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  // Request pacing. A large per-ticker batch (financials over ~150 names = ~300
  // calls) bursts FMP hard enough that it silently returns empty 200s for a
  // rotating subset — no 429, no error, just missing data that never converges
  // across re-runs. A minimum gap between requests spreads the burst so every
  // call gets a real response. `nextSlot` reserves evenly-spaced send times even
  // when callers fire concurrently.
  private readonly minIntervalMs: number;
  private nextSlot = 0;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get("FMP_API_KEY", "");
    this.baseUrl = this.config
      .get("FMP_API_BASE_URL", DEFAULT_BASE_URL)
      .replace(/\/$/, "");
    this.minIntervalMs = Number(this.config.get("FMP_MIN_INTERVAL_MS", "50"));
    if (!this.apiKey) {
      this.logger.warn(
        "FMP_API_KEY not set — FMP-backed features stay disabled (Polygon-only). Set the key and the relevant *_SOURCE=fmp to enable.",
      );
    }
  }

  /** True once a key is present — callers should skip work when disabled. */
  get enabled(): boolean {
    return !!this.apiKey;
  }

  /** Reserve the next evenly-spaced send slot, then wait until it arrives. Safe
   * under concurrency: each caller claims a distinct slot `minIntervalMs` apart. */
  private async pace(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    const wait = slot - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  private async get(path: string, opts?: FetchJsonOptions): Promise<unknown[]> {
    await this.pace();
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetchJson<unknown>(
      `${this.baseUrl}/${path}${sep}apikey=${this.apiKey}`,
      opts,
    );
    return Array.isArray(res) ? res : [];
  }

  /**
   * Bulk earnings calendar for a date window (`/stable/earnings-calendar`) —
   * ONE request covering every company, carrying the analyst EPS/revenue
   * estimates Polygon lacks. `date` is the report date.
   */
  async getEarningsCalendar(
    from: string,
    to: string,
  ): Promise<FmpEarningRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(`earnings-calendar?from=${from}&to=${to}`);
    return rows.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        date: String(o.date ?? ""),
        symbol: String(o.symbol ?? ""),
        epsEstimated: num(o.epsEstimated),
        revenueEstimated: num(o.revenueEstimated),
        epsActual: num(o.epsActual),
        revenueActual: num(o.revenueActual),
      };
    });
  }

  /**
   * Per-ticker stock news (`/stable/news/stock`). `site` is the publishing
   * outlet; some responses also carry a `sentiment` label which we pass through.
   */
  async getStockNews(
    symbol: string,
    from: string,
    to: string,
  ): Promise<FmpNewsRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(
      `news/stock?symbols=${encodeURIComponent(symbol)}&from=${from}&to=${to}&limit=20`,
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      symbol: (r.symbol as string) ?? symbol,
      publishedDate: String(r.publishedDate ?? r.date ?? ""),
      title: String(r.title ?? ""),
      text: (r.text as string) ?? null,
      site: (r.site as string) ?? (r.publisher as string) ?? null,
      url: String(r.url ?? ""),
      image: (r.image as string) ?? null,
      sentiment: (r.sentiment as string) ?? null,
    }));
  }

  /**
   * Analyst grades consensus (`/stable/grades-consensus`) — Buy/Hold/Sell vote
   * tallies + a label for one ticker. `retries:0` so a momentary 429 drops the
   * ticker fast instead of stalling the whole board.
   */
  async getAnalystConsensus(ticker: string): Promise<FmpConsensusRow | null> {
    if (!this.apiKey) return null;
    const rows = await this.get(
      `grades-consensus?symbol=${encodeURIComponent(ticker)}`,
      { retries: 0 },
    );
    if (rows.length === 0) return null;
    const o = rows[0] as Record<string, unknown>;
    return {
      symbol: String(o.symbol ?? ticker),
      strongBuy: num(o.strongBuy),
      buy: num(o.buy),
      hold: num(o.hold),
      sell: num(o.sell),
      strongSell: num(o.strongSell),
      consensus: o.consensus != null ? String(o.consensus) : null,
    };
  }

  /** Sector performance snapshot (`/stable/sector-performance-snapshot`). */
  async getSectorPerformance(): Promise<FmpSectorPerformanceRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(`sector-performance-snapshot`);
    return rows.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        sector: String(o.sector ?? ""),
        changesPercentage: (o.averageChange ?? o.changesPercentage ?? null) as
          string | number | null,
      };
    });
  }

  /**
   * Forward annual analyst estimates (`/stable/analyst-estimates`) — avg
   * EPS/revenue per fiscal year, the source for the `*YYYY` forward rows.
   */
  async getForwardAnnualEstimates(
    ticker: string,
  ): Promise<FmpAnalystEstimateRow[]> {
    if (!this.apiKey) return [];
    // limit=40: enough annual rows that the forward years (current FY onward)
    // are always in the response regardless of FMP's sort order. limit=8 could
    // return only old years for companies with long estimate histories, which
    // the `>= thisYear` filter in the adapter then drops to empty.
    const rows = await this.get(
      `analyst-estimates?symbol=${encodeURIComponent(ticker)}&period=annual&limit=40`,
    );
    return rows.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        date: String(o.date ?? ""),
        symbol: String(o.symbol ?? ticker),
        estimatedEpsAvg: num(o.epsAvg ?? o.estimatedEpsAvg),
        estimatedRevenueAvg: num(o.revenueAvg ?? o.estimatedRevenueAvg),
      };
    });
  }

  /**
   * Per-ticker earnings history (`/stable/earnings`) — actual + estimated EPS
   * across all reported quarters, the source for the quarterly %surp column.
   */
  async getEarningsSurprises(
    ticker: string,
  ): Promise<FmpEarningsSurpriseRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(
      `earnings?symbol=${encodeURIComponent(ticker)}&limit=40`,
    );
    return rows.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        date: String(o.date ?? ""),
        symbol: String(o.symbol ?? ticker),
        actualEarningResult: num(o.epsActual ?? o.actualEarningResult),
        estimatedEarning: num(o.epsEstimated ?? o.estimatedEarning),
      };
    });
  }

  /**
   * Analyst price-target consensus (`/stable/price-target-consensus`) — the
   * high/low/average/median 12-month target across covering firms. `retries:0`
   * so a momentary miss drops the ticker fast instead of stalling the sweep.
   */
  async getPriceTargetConsensus(
    ticker: string,
  ): Promise<FmpPriceTargetConsensusRow | null> {
    if (!this.apiKey) return null;
    const rows = await this.get(
      `price-target-consensus?symbol=${encodeURIComponent(ticker)}`,
      { retries: 0 },
    );
    if (rows.length === 0) return null;
    const o = rows[0] as Record<string, unknown>;
    return {
      targetHigh: num(o.targetHigh),
      targetLow: num(o.targetLow),
      targetConsensus: num(o.targetConsensus),
      targetMedian: num(o.targetMedian),
    };
  }

  /**
   * Rolling average price target (`/stable/price-target-summary`) — mean target
   * over the last month/quarter/year, so the UI can show whether targets trend
   * up or down.
   */
  async getPriceTargetSummary(
    ticker: string,
  ): Promise<FmpPriceTargetSummaryRow | null> {
    if (!this.apiKey) return null;
    const rows = await this.get(
      `price-target-summary?symbol=${encodeURIComponent(ticker)}`,
      { retries: 0 },
    );
    if (rows.length === 0) return null;
    const o = rows[0] as Record<string, unknown>;
    return {
      lastMonthCount: num(o.lastMonthCount),
      lastMonthAvg: num(o.lastMonthAvgPriceTarget),
      lastQuarterCount: num(o.lastQuarterCount),
      lastQuarterAvg: num(o.lastQuarterAvgPriceTarget),
      lastYearCount: num(o.lastYearCount),
      lastYearAvg: num(o.lastYearAvgPriceTarget),
    };
  }

  /**
   * Per-firm rating changes (`/stable/grades`) — the analyst-action event feed
   * Polygon has no equivalent for: which firm, from→to grade, and the action
   * (upgrade/downgrade/initiate/maintain). Newest first; `limit` bounds the pull.
   */
  async getGrades(ticker: string, limit = 10): Promise<FmpGradeRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(
      `grades?symbol=${encodeURIComponent(ticker)}&limit=${limit}`,
      { retries: 0 },
    );
    // FMP's `grades` endpoint IGNORES the limit param and returns the full
    // history (1000s of rows) newest-first — slice here or a batch write blows
    // past Firestore's 11.5MB limit.
    return rows.slice(0, limit).map((r) => {
      const o = r as Record<string, unknown>;
      return {
        date: String(o.date ?? ""),
        gradingCompany: o.gradingCompany != null ? String(o.gradingCompany) : null,
        previousGrade: o.previousGrade != null ? String(o.previousGrade) : null,
        newGrade: o.newGrade != null ? String(o.newGrade) : null,
        action: o.action != null ? String(o.action) : null,
      };
    });
  }

  /**
   * Per-firm price targets (`/stable/price-target-news`) — each covering firm's
   * OWN 12-month target + the date it was posted. Joined to grades by firm so
   * the "Per-firm analyst actions" table shows real per-firm PTs instead of the
   * ticker's single consensus repeated on every row.
   */
  async getPriceTargets(
    ticker: string,
    limit = 60,
  ): Promise<FmpPriceTargetRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(
      `price-target-news?symbol=${encodeURIComponent(ticker)}&limit=${limit}`,
      { retries: 0 },
    ).catch(() => [] as unknown[]);
    return rows
      .map((r) => {
        const o = r as Record<string, unknown>;
        return {
          date: String(o.publishedDate ?? o.date ?? "").slice(0, 10),
          firm: o.analystCompany != null ? String(o.analystCompany) : null,
          priceTarget: num(o.priceTarget ?? o.adjPriceTarget),
        };
      })
      .filter((r) => r.firm && r.priceTarget != null);
  }

  /**
   * Economic calendar (`/stable/economic-calendar`) — scheduled + released macro
   * events (CPI, PPI, jobs, FOMC…) with date, estimate, previous and actual. This
   * is the forward release schedule FRED cannot provide (FRED has only past
   * observations). `date` carries a time; callers take the date part.
   */
  async getEconomicCalendar(
    from: string,
    to: string,
  ): Promise<FmpEconEventRow[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(`economic-calendar?from=${from}&to=${to}`);
    return rows.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        date: String(o.date ?? ""),
        country: o.country != null ? String(o.country) : null,
        event: o.event != null ? String(o.event) : null,
        currency: o.currency != null ? String(o.currency) : null,
        previous: num(o.previous),
        estimate: num(o.estimate),
        actual: num(o.actual),
        impact: o.impact != null ? String(o.impact) : null,
        unit: o.unit != null ? String(o.unit) : null,
      };
    });
  }

  /**
   * One earnings-call transcript for an explicit fiscal (year, quarter)
   * (`/stable/earning-call-transcript?symbol=&year=&quarter=`). Returns null
   * when FMP has no transcript for that exact period. `period` on the response
   * is the quarter (e.g. "Q2" or 2) — parsed to a number defensively.
   */
  async getEarningsTranscript(
    ticker: string,
    year: number,
    quarter: number,
  ): Promise<FmpTranscriptRow | null> {
    if (!this.apiKey) return null;
    const rows = await this.get(
      `earning-call-transcript?symbol=${encodeURIComponent(ticker)}&year=${year}&quarter=${quarter}`,
    );
    const o = rows[0] as Record<string, unknown> | undefined;
    const content = o?.content != null ? String(o.content) : "";
    if (!o || !content.trim()) return null;
    return {
      symbol: String(o.symbol ?? ticker),
      quarter: quarterNum(o.period ?? o.quarter) ?? quarter,
      year: num(o.year) ?? year,
      date: o.date != null ? String(o.date) : null,
      content,
    };
  }

  /**
   * The (year, quarter) periods FMP has a transcript for, newest first
   * (`/stable/earning-call-transcript-dates?symbol=`). Used to resolve the
   * latest call without guessing the calendar quarter. Parsed defensively:
   * FMP has returned both objects ({quarter,year,date}) and tuple arrays
   * ([quarter,year,date]) across versions.
   */
  async getTranscriptDates(ticker: string): Promise<FmpTranscriptDate[]> {
    if (!this.apiKey) return [];
    const rows = await this.get(
      `earning-call-transcript-dates?symbol=${encodeURIComponent(ticker)}`,
    );
    const parsed = rows.map((r): FmpTranscriptDate => {
      if (Array.isArray(r)) {
        return { quarter: quarterNum(r[0]), year: num(r[1]), date: r[2] != null ? String(r[2]) : null };
      }
      const o = r as Record<string, unknown>;
      return {
        quarter: quarterNum(o.quarter ?? o.period),
        year: num(o.year ?? o.fiscalYear),
        date: o.date != null ? String(o.date) : null,
      };
    });
    return parsed
      .filter((d) => d.year != null && d.quarter != null)
      .sort((a, b) => (b.year! - a.year!) || (b.quarter! - a.quarter!));
  }

  /**
   * The most recent earnings-call transcript for a ticker. Resolves the latest
   * (year, quarter) from `getTranscriptDates` when available; if that endpoint
   * yields nothing, falls back to probing the last few calendar quarters so a
   * transcript is still found. Returns null when none exists / FMP is off.
   */
  async getLatestEarningsTranscript(
    ticker: string,
  ): Promise<FmpTranscriptRow | null> {
    if (!this.apiKey) return null;

    const tryFetch = (year: number, quarter: number) =>
      this.getEarningsTranscript(ticker, year, quarter).catch(() => null);

    const dates = await this.getTranscriptDates(ticker).catch(() => []);
    for (const d of dates.slice(0, 4)) {
      const tx = await tryFetch(d.year!, d.quarter!);
      if (tx) return tx;
    }

    // Fallback: dates endpoint gave nothing — probe recent calendar quarters
    // (most recent first). Earnings for a quarter are reported the following
    // one, so the current calendar quarter is usually not yet available.
    for (const { year, quarter } of recentQuarters(6)) {
      const tx = await tryFetch(year, quarter);
      if (tx) return tx;
    }
    return null;
  }

  /**
   * Per-ticker institutional-ownership summary for an explicit (year, quarter)
   * (`/stable/institutional-ownership/symbol-positions-summary`). Returns null
   * when FMP has no 13F rollup for that ticker/period.
   */
  async getInstitutionalOwnership(
    ticker: string,
    year: number,
    quarter: number,
  ): Promise<FmpInstitutionalOwnershipRow | null> {
    if (!this.apiKey) return null;
    const rows = await this.get(
      `institutional-ownership/symbol-positions-summary?symbol=${encodeURIComponent(ticker)}&year=${year}&quarter=${quarter}`,
    );
    const o = rows[0] as Record<string, unknown> | undefined;
    if (!o) return null;
    const investorsHolding = num(o.investorsHolding);
    if (investorsHolding == null) return null; // no real rollup for this period
    return {
      symbol: String(o.symbol ?? ticker),
      year: num(o.year) ?? year,
      quarter: quarterNum(o.quarter ?? o.period) ?? quarter,
      investorsHolding,
      lastInvestorsHolding: num(o.lastInvestorsHolding),
      investorsHoldingChange: num(o.investorsHoldingChange),
      numberOf13Fshares: num(o.numberOf13Fshares),
      lastNumberOf13Fshares: num(o.lastNumberOf13Fshares),
      numberOf13FsharesChange: num(o.numberOf13FsharesChange),
      totalInvested: num(o.totalInvested),
      ownershipPercent: num(o.ownershipPercent),
      putCallRatio: num(o.putCallRatio),
    };
  }

  /**
   * The most-recent institutional-ownership summary for a ticker. 13F rollups
   * lag the quarter end by ~45 days, so the current calendar quarter is usually
   * not yet published — probe the last few quarters, newest first. Returns null
   * (and the resolved period on success) so a caller can reuse the period for a
   * batch of tickers instead of re-probing each one.
   */
  async getLatestInstitutionalOwnership(
    ticker: string,
  ): Promise<FmpInstitutionalOwnershipRow | null> {
    if (!this.apiKey) return null;
    for (const { year, quarter } of recentQuarters(5)) {
      const row = await this.getInstitutionalOwnership(ticker, year, quarter).catch(
        () => null,
      );
      if (row) return row;
    }
    return null;
  }
}

/** Parses FMP's quarter field ("Q2", "2", 2) into a 1-4 number, else null. */
function quarterNum(v: unknown): number | null {
  if (typeof v === "number") return v >= 1 && v <= 4 ? v : null;
  if (typeof v === "string") {
    const m = v.match(/[1-4]/);
    return m ? Number(m[0]) : null;
  }
  return null;
}

/** The last `count` calendar quarters, most recent first, from a fixed clock. */
function recentQuarters(count: number): Array<{ year: number; quarter: number }> {
  const now = new Date();
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3) + 1; // 1-4
  const out: Array<{ year: number; quarter: number }> = [];
  for (let i = 0; i < count; i++) {
    out.push({ year, quarter });
    quarter -= 1;
    if (quarter < 1) { quarter = 4; year -= 1; }
  }
  return out;
}
