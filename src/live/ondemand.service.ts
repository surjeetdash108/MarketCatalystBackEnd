import { Inject, Injectable, Logger } from "@nestjs/common";
import { NEWS_ADAPTER, type NewsAdapter } from "../adapters/types";
import {
  annualTotals,
  dividendCagr,
  increaseStreak,
} from "../sync/corporate-actions.job";
import { mapAnnualRow, mapQuarterRow } from "../sync/financials.job";
import {
  PolygonService,
  PolygonAggBar,
} from "../vendors/polygon/polygon.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ON-DEMAND DATA LAYER (live-direct).
 *
 * Every method fetches from the vendor (Polygon / the news adapter) on each
 * request and returns — there is NO caching of any kind: no in-memory Map, no
 * Firestore read, no Firestore write, no in-flight coalescing. The per-request
 * cost is one (or a few) vendor calls; the edge/browser Cache-Control headers on
 * the controller absorb repeat views.
 *
 *   browser → GET /live/bars|/live/company|… → vendor call → response
 *
 * Method signatures and return shapes are unchanged from the previous
 * cache-aside version, so controllers and the frontend are untouched.
 */

export type BarsTf = "1H" | "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "5Y";
type Resolution = "1min" | "5min" | "30min" | "daily";

export const BARS_TFS: BarsTf[] = [
  "1H",
  "1D",
  "1W",
  "1M",
  "3M",
  "6M",
  "1Y",
  "5Y",
];

interface TfSpec {
  resolution: Resolution;
  /** Calendar days to request from the vendor for this resolution family. */
  fetchDays: number;
  /** Bars to return to the client (newest N). */
  sliceBars: number;
}

/** fetchDays covers weekends/holidays so the slice always fills. */
const TF: Record<BarsTf, TfSpec> = {
  "1H": { resolution: "1min", fetchDays: 5, sliceBars: 60 },
  "1D": { resolution: "5min", fetchDays: 9, sliceBars: 78 }, // 1 session ≈ 78 5-min bars
  "1W": { resolution: "5min", fetchDays: 9, sliceBars: 390 }, // 5 sessions
  "1M": { resolution: "30min", fetchDays: 40, sliceBars: 286 }, // 22 sessions × 13 bars
  "3M": { resolution: "daily", fetchDays: 95, sliceBars: 64 },
  "6M": { resolution: "daily", fetchDays: 190, sliceBars: 128 },
  "1Y": { resolution: "daily", fetchDays: 380, sliceBars: 252 },
  "5Y": { resolution: "daily", fetchDays: 1830, sliceBars: 1300 },
};

const RES_PARAMS: Record<
  Resolution,
  { multiplier: number; timespan: "minute" | "hour" | "day" }
> = {
  "1min": { multiplier: 1, timespan: "minute" },
  "5min": { multiplier: 5, timespan: "minute" },
  "30min": { multiplier: 30, timespan: "minute" },
  daily: { multiplier: 1, timespan: "day" },
};

export interface StoredBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number | null;
}

// Dividend history / splits / financials shaping parameters.
const DIV_HISTORY_LIMIT = 200;
const DIV_ANNUAL_YEARS = 10;
const DIV_CAGR_YEARS = 5;
const FIN_QUARTERS = 10;
const FIN_ANNUAL_YEARS = 8;

const NEWS_LOOKBACK_DAYS = 2;
const NEWS_ARTICLE_CAP = 5;

const OPTIONS_CONTRACTS_LIMIT = 20;
const OPTIONS_AGG_LOOKBACK_DAYS = 10;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class OnDemandService {
  private readonly logger = new Logger(OnDemandService.name);

  /** Lightweight observability for the /live/ondemand-stats endpoint. */
  readonly stats = {
    barsRequests: 0,
    barsVendorCalls: 0,
    companyRequests: 0,
    companyVendorCalls: 0,
    lastError: "",
  };

  constructor(
    private readonly polygon: PolygonService,
    @Inject(NEWS_ADAPTER) private readonly news: NewsAdapter,
  ) {}

  // ── Bars ────────────────────────────────────────────────────────────────

  isValidTf(tf: string): tf is BarsTf {
    return (BARS_TFS as string[]).includes(tf);
  }

  /**
   * Bars for one ticker+timeframe, live-direct. Returns the newest N bars for
   * the timeframe (oldest-first). ONE Polygon call per request.
   */
  async getBars(
    ticker: string,
    tf: BarsTf,
  ): Promise<{
    ticker: string;
    tf: BarsTf;
    bars: StoredBar[];
    source: "vendor";
    asOf: string;
  }> {
    this.stats.barsRequests++;
    const spec = TF[tf];
    const { multiplier, timespan } = RES_PARAMS[spec.resolution];
    const to = new Date();
    const from = new Date(to.getTime() - spec.fetchDays * 86_400_000);
    this.stats.barsVendorCalls++;
    const raw: PolygonAggBar[] = await this.polygon.getAggsRange(
      ticker,
      isoDate(from),
      isoDate(to),
      timespan,
      multiplier,
      50_000,
    );
    const bars: StoredBar[] = raw.map((b) => ({
      t: b.t,
      o: b.o,
      h: b.h,
      l: b.l,
      c: b.c,
      v: b.v,
      vw: b.vw ?? null,
    }));
    return {
      ticker,
      tf,
      bars: bars.slice(-spec.sliceBars),
      source: "vendor",
      asOf: new Date().toISOString(),
    };
  }

  // ── Company profile ─────────────────────────────────────────────────────

  /** Company profile + latest price, live-direct. */
  async getCompany(ticker: string): Promise<Record<string, unknown> | null> {
    this.stats.companyRequests++;
    this.stats.companyVendorCalls++;
    let details: Record<string, unknown> | null = null;
    try {
      details = await this.polygon.getTickerDetails(ticker);
    } catch {
      details = null; // unknown ticker — still try the snapshot
    }
    const quotes = await this.polygon
      .getUniversalSnapshot([ticker])
      .catch(() => []);
    const q = quotes[0] as Record<string, unknown> | undefined;
    if (!details && !q) return null;

    const now = new Date().toISOString();
    return {
      ticker,
      name: details?.name ?? ticker,
      description: details?.description ?? null,
      homepageUrl: details?.homepage_url ?? null,
      sector: details?.sic_description ?? null,
      marketCap: details?.market_cap ?? null,
      exchange: details?.primary_exchange ?? null,
      price: q?.price ?? null,
      pctChange: q?.changePercent ?? null,
      prevClose: q?.previousClose ?? null,
      volume: q?.volume ?? null,
      createdAt: now,
      updatedAt: now,
      source: "polygon-ondemand",
    };
  }

  /**
   * Lightweight multi-ticker quotes (price + %change) in ONE Polygon
   * universal-snapshot call.
   */
  async getQuotes(tickers: string[]): Promise<
    Array<{
      ticker: string;
      name: string | null;
      price: number | null;
      pctChange: number | null;
    }>
  > {
    const syms = [
      ...new Set(tickers.map((t) => t.toUpperCase().trim()).filter(Boolean)),
    ].slice(0, 25);
    if (syms.length === 0) return [];
    const snaps = await this.polygon.getUniversalSnapshot(syms).catch(() => []);
    return (snaps as Array<Record<string, unknown>>).map((s) => ({
      ticker: String(s.ticker),
      name: (s.name as string) ?? null,
      price: (s.price as number) ?? null,
      pctChange: (s.changePercent as number) ?? null,
    }));
  }

  // ── Company logo (Polygon branding, proxied) ────────────────────────────

  /**
   * Company logo bytes from Polygon's ticker `branding`, proxied server-side so
   * the API key never reaches the browser. Returns null when Polygon has no
   * branding for the ticker (caller → letter tile). The endpoint sets a long
   * edge/browser Cache-Control so a logo-heavy grid is absorbed at the edge.
   */
  async getLogo(
    ticker: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    return this.polygon.getBrandingImage(ticker).catch(() => null);
  }

  // ── Dividend history ────────────────────────────────────────────────────

  /** Per-ticker dividend history, live-direct from Polygon. */
  async getDividendHistory(
    ticker: string,
  ): Promise<Record<string, unknown> | null> {
    const history = await this.polygon.getDividendHistory(
      ticker,
      DIV_HISTORY_LIMIT,
    );
    const totals = annualTotals(history);
    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const ttm = history.filter(
      (d) => d.exDividendDate != null && d.exDividendDate >= cutoffIso,
    );
    const ttmTotal = ttm.reduce((s, d) => s + (d.cashAmount ?? 0), 0);
    const company: Record<string, unknown> | null = await this.getCompany(
      ticker,
    ).catch(() => null);
    const price: number | null = (company?.price as number | undefined) ?? null;

    const now = new Date().toISOString();
    return {
      ticker,
      history: history.map((d) => ({
        exDividendDate: d.exDividendDate,
        paymentDate: d.paymentDate,
        declarationDate: d.declarationDate,
        recordDate: d.recordDate,
        amount: d.cashAmount,
        dividendType: d.dividendType,
        frequency: d.frequency,
      })),
      annualTotals: totals.slice(0, DIV_ANNUAL_YEARS),
      ttmTotal: ttm.length > 0 ? Math.round(ttmTotal * 10000) / 10000 : null,
      ttmPayments: ttm.length,
      yieldPct:
        price != null && ttm.length > 0
          ? Math.round((ttmTotal / price) * 10000) / 100
          : null,
      yieldBasisPrice: price,
      cagr5yPct: dividendCagr(totals, DIV_CAGR_YEARS),
      increaseStreakYears: increaseStreak(totals),
      frequency: history[0]?.frequency ?? null,
      isPayer: history.length > 0,
      source: "polygon-ondemand",
      createdAt: now,
      updatedAt: now,
    };
  }

  // ── Splits ──────────────────────────────────────────────────────────────

  /** Per-ticker split history, live-direct from Polygon. */
  async getSplits(ticker: string): Promise<Record<string, unknown> | null> {
    const splits = await this.polygon.getSplits(ticker);
    const now = new Date().toISOString();
    return {
      ticker,
      splits,
      latestSplit: splits[0] ?? null,
      source: "polygon-ondemand",
      createdAt: now,
      updatedAt: now,
    };
  }

  // ── Financials ──────────────────────────────────────────────────────────

  /**
   * Per-ticker quarterly+annual financials, live-direct from Polygon. Polygon
   * carries no forward EPS estimates and the synced `earnings_events` cache is
   * gone, so the per-quarter EPS estimate line is dropped (null) — degraded.
   */
  async getFinancials(ticker: string): Promise<Record<string, unknown> | null> {
    const rows = await this.polygon.getFinancialStatements(
      ticker,
      "quarterly",
      FIN_QUARTERS,
    );
    const quarters = rows.map((r) => mapQuarterRow(r, null));

    let annual: ReturnType<typeof mapAnnualRow>[] = [];
    try {
      const yr = await this.polygon.getFinancialStatements(
        ticker,
        "annual",
        FIN_ANNUAL_YEARS,
      );
      annual = yr.map(mapAnnualRow);
    } catch {
      // Annual is a secondary tab — a failure there shouldn't block quarterly data.
    }

    const now = new Date().toISOString();
    return {
      ticker,
      quarters,
      annual,
      source: "polygon-ondemand",
      createdAt: now,
      updatedAt: now,
    };
  }

  // ── Per-ticker news ─────────────────────────────────────────────────────

  /** Per-ticker news, live-direct from the news adapter (newest first). */
  async getNews(ticker: string): Promise<Record<string, unknown>[]> {
    const to = new Date();
    const from = new Date(to.getTime() - NEWS_LOOKBACK_DAYS * 86_400_000);
    const result = await this.news.fetchNews(ticker, isoDate(from), isoDate(to));
    const now = new Date().toISOString();
    return result.data.slice(0, NEWS_ARTICLE_CAP).map((a) => ({
      id: `${ticker}_${a.id}`,
      ticker: a.ticker,
      headline: a.headline,
      summary: a.summary,
      source: a.source,
      url: a.url,
      category: a.category,
      sentiment: a.sentiment,
      sentimentReasoning: a.sentimentReasoning,
      keywords: a.keywords,
      imageUrl: a.imageUrl,
      publishedAt: a.publishedAt,
      updatedAt: now,
    }));
  }

  // ── Options chain (curated 8-ticker universe) ──────────────────────────

  /**
   * Per-ticker options chain, live-direct from Polygon (strikes/expirations/
   * OHLCV are real; bid/ask, IV, greeks and open interest are NOT_AUTHORIZED on
   * the current Polygon plan). Callers reject tickers outside OPTIONS_UNIVERSE
   * before calling this.
   */
  async getOptionsChain(
    ticker: string,
  ): Promise<Record<string, unknown> | null> {
    const today = isoDate(new Date());
    const lookback = new Date();
    lookback.setUTCDate(lookback.getUTCDate() - OPTIONS_AGG_LOOKBACK_DAYS);
    const from = isoDate(lookback);

    const contracts = await this.polygon.getOptionContracts(
      ticker,
      today,
      OPTIONS_CONTRACTS_LIMIT,
    );
    const enriched: Record<string, unknown>[] = [];
    for (const c of contracts) {
      try {
        const bar = await this.polygon.getOptionLatestBar(c.ticker, from, today);
        enriched.push({
          contractTicker: c.ticker,
          contractType: c.contract_type,
          strike: c.strike_price,
          expirationDate: c.expiration_date,
          exerciseStyle: c.exercise_style ?? null,
          sharesPerContract: c.shares_per_contract ?? null,
          lastOpen: bar?.o ?? null,
          lastHigh: bar?.h ?? null,
          lastLow: bar?.l ?? null,
          lastClose: bar?.c ?? null,
          lastVwap: bar?.vw ?? null,
          lastVolume: bar?.v ?? null,
          lastTradeCount: bar?.n ?? null,
          lastBarDate: bar ? isoDate(new Date(bar.t)) : null,
          lastRangePct:
            bar && bar.o > 0
              ? Math.round(((bar.h - bar.l) / bar.o) * 10000) / 100
              : null,
        });
      } catch (err) {
        this.logger.warn(
          `options on-demand: bar fetch failed for ${c.ticker}: ${(err as Error).message}`,
        );
      }
      await sleep(this.polygon.requestDelayMs);
    }

    const now = new Date().toISOString();
    return {
      underlyingTicker: ticker,
      contracts: enriched,
      source: "polygon-ondemand",
      note: "Strikes, expirations and per-contract OHLCV/VWAP/volume are real (delayed). Bid/ask, IV, greeks and open interest return NOT_AUTHORIZED on the current Polygon plan — they need the Options add-on.",
      createdAt: now,
      updatedAt: now,
    };
  }
}
