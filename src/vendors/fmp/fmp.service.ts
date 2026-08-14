import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchJson } from "../../common/http.util";

/**
 * Financial Modeling Prep (FMP) — a SUPPLEMENTARY vendor, wired only for the
 * data Polygon structurally cannot provide (earnings estimates/surprises,
 * analyst ratings) plus a couple of optional conveniences (sector performance,
 * profile ratios). It NEVER supplies price/OHLCV/snapshot/news/corporate
 * actions — those stay Polygon-owned so there is a single source of truth for
 * price.
 *
 * Every FMP feature is opt-in behind a `<DOMAIN>_SOURCE` env var that defaults
 * to "none" (off). With FMP_API_KEY unset and every source left at "none",
 * this service is constructed but never called, and the app behaves exactly as
 * a Polygon-only build. To remove FMP entirely: set every `*_SOURCE` back to
 * "none", then delete `src/vendors/fmp/` and the FMP adapters.
 *
 * Auth is a `?apikey=` query param (already redacted in logs by http.util).
 */

const DEFAULT_BASE_URL = "https://financialmodelingprep.com";

/** One row of GET /api/v3/earning_calendar — all companies over a date range. */
export interface FmpEarningRow {
  date: string;
  symbol: string;
  eps: number | null;
  epsEstimated: number | null;
  revenue: number | null;
  revenueEstimated: number | null;
  fiscalDateEnding?: string | null;
}

/** GET /api/v4/upgrades-downgrades-consensus?symbol= — analyst rating tallies. */
export interface FmpConsensusRow {
  symbol: string;
  strongBuy: number | null;
  buy: number | null;
  hold: number | null;
  sell: number | null;
  strongSell: number | null;
  consensus: string | null;
}

/** GET /api/v3/sectors-performance — one row per GICS sector. */
export interface FmpSectorPerformanceRow {
  sector: string;
  /** e.g. "0.62%" or a bare number, depending on plan/version. */
  changesPercentage: string | number | null;
}

/** GET /api/v3/analyst-estimates/{symbol}?period=annual — forward consensus. */
export interface FmpAnalystEstimateRow {
  date: string; // fiscal period end, e.g. "2026-12-31"
  symbol: string;
  estimatedEpsAvg: number | null;
  estimatedRevenueAvg: number | null;
}

/** GET /api/v3/earnings-surprises/{symbol} — full actual-vs-estimate history. */
export interface FmpEarningsSurpriseRow {
  date: string; // report / period date, e.g. "2025-06-30"
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

  /**
   * Bulk earnings calendar for a date window — ONE request covering every
   * company, so the earnings job needs a single call rather than one per
   * ticker. Carries the analyst EPS/revenue estimates Polygon lacks.
   */
  async getEarningsCalendar(
    from: string,
    to: string,
  ): Promise<FmpEarningRow[]> {
    if (!this.apiKey) return [];
    const res = await fetchJson<FmpEarningRow[]>(
      `${this.baseUrl}/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${this.apiKey}`,
    );
    return Array.isArray(res) ? res : [];
  }

  /**
   * Analyst rating consensus (Strong Buy / Buy / Hold / Sell / Strong Sell
   * counts + a label) for one ticker — the data Polygon has no feed for.
   */
  async getAnalystConsensus(ticker: string): Promise<FmpConsensusRow | null> {
    if (!this.apiKey) return null;
    const res = await fetchJson<FmpConsensusRow[]>(
      `${this.baseUrl}/api/v4/upgrades-downgrades-consensus?symbol=${encodeURIComponent(ticker)}&apikey=${this.apiKey}`,
    );
    return Array.isArray(res) && res.length > 0 ? res[0] : null;
  }

  /**
   * Real cap-weighted sector performance (one call) — replaces the ETF proxy.
   */
  async getSectorPerformance(): Promise<FmpSectorPerformanceRow[]> {
    if (!this.apiKey) return [];
    const res = await fetchJson<
      | FmpSectorPerformanceRow[]
      | { sectorPerformance?: FmpSectorPerformanceRow[] }
    >(`${this.baseUrl}/api/v3/sectors-performance?apikey=${this.apiKey}`);
    if (Array.isArray(res)) return res;
    return res?.sectorPerformance ?? [];
  }

  /**
   * Forward annual analyst estimates (avg EPS/revenue per fiscal year) for one
   * ticker — the source for the `*2026–28` forward rows Polygon can't provide.
   */
  async getForwardAnnualEstimates(
    ticker: string,
  ): Promise<FmpAnalystEstimateRow[]> {
    if (!this.apiKey) return [];
    const res = await fetchJson<FmpAnalystEstimateRow[]>(
      `${this.baseUrl}/api/v3/analyst-estimates/${encodeURIComponent(ticker)}?period=annual&limit=8&apikey=${this.apiKey}`,
    );
    return Array.isArray(res) ? res : [];
  }

  /**
   * Full EPS actual-vs-estimate history for one ticker — the source for the
   * quarterly %surp column across ALL displayed quarters (not just the last
   * 180 days the earnings calendar covers).
   */
  async getEarningsSurprises(
    ticker: string,
  ): Promise<FmpEarningsSurpriseRow[]> {
    if (!this.apiKey) return [];
    const res = await fetchJson<FmpEarningsSurpriseRow[]>(
      `${this.baseUrl}/api/v3/earnings-surprises/${encodeURIComponent(ticker)}?apikey=${this.apiKey}`,
    );
    return Array.isArray(res) ? res : [];
  }
}
