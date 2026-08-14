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

const num = (v: unknown): number | null =>
  typeof v === "number" ? v : v == null ? null : Number(v) || null;

/** Normalised earnings-calendar row (per report date, all companies). */
export interface FmpEarningRow {
  date: string;
  symbol: string;
  epsEstimated: number | null;
  revenueEstimated: number | null;
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

@Injectable()
export class FmpService {
  private readonly logger = new Logger(FmpService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get("FMP_API_KEY", "");
    this.baseUrl = this.config
      .get("FMP_API_BASE_URL", DEFAULT_BASE_URL)
      .replace(/\/$/, "");
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

  private async get(path: string, opts?: FetchJsonOptions): Promise<unknown[]> {
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
      };
    });
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
    const rows = await this.get(
      `analyst-estimates?symbol=${encodeURIComponent(ticker)}&period=annual&limit=8`,
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
}
