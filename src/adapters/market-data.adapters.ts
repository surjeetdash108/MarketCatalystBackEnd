import { Logger } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FmpService } from "../vendors/fmp/fmp.service";
import type {
  AdapterResult,
  CanonicalBar,
  CanonicalFinancialStatement,
  CanonicalIncomeStatement,
  CanonicalTickerRef,
  FinancialsAdapter,
  FinancialsTimeframe,
  MarketBarsAdapter,
  TickerUniverseAdapter,
} from "./types";
import { withFallback } from "./with-fallback.util";
import { isoDateFromMs } from "../common/date.util";

/**
 * Seams for the three domains that were hardcoded to PolygonService: daily bars,
 * the ticker universe, and financial statements.
 *
 * Bars and the universe are Polygon-only; financials also has an FMP
 * implementation (fmp-financials.adapter.ts). Adding a vendor means writing one
 * class and adding one line to the `bySource` map in adapters.module.ts; no job
 * changes.
 *
 * These adapters also normalize away vendor encoding: Polygon's epoch-millis
 * `t` becomes an ISO date, and its snake_case reference fields become camelCase,
 * so a future vendor maps to the canonical shape rather than to Polygon's.
 */


// ── Daily bars ──────────────────────────────────────────────────────────────

export class PolygonMarketBarsAdapter implements MarketBarsAdapter {
  readonly sourceName = "polygon";
  constructor(private readonly polygon: PolygonService) {}

  get requestDelayMs() {
    return this.polygon.requestDelayMs;
  }

  async fetchDailyBars(
    ticker: string,
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalBar[]>> {
    const bars = await this.polygon.getAggsRange(ticker, from, to);
    return {
      data: bars.map((b) => ({
        date: isoDateFromMs(b.t),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
        vwap: b.vw ?? null,
      })),
      source: this.sourceName,
      warnings: [],
    };
  }
}

export class CompositeMarketBarsAdapter implements MarketBarsAdapter {
  private readonly logger = new Logger(CompositeMarketBarsAdapter.name);
  readonly sourceName: string;

  constructor(
    private readonly primary: MarketBarsAdapter,
    private readonly secondary: MarketBarsAdapter | null,
  ) {
    this.sourceName = secondary
      ? `${primary.sourceName}(fallback:${secondary.sourceName})`
      : primary.sourceName;
  }

  get requestDelayMs() {
    return this.primary.requestDelayMs;
  }

  fetchDailyBars(ticker: string, from: string, to: string) {
    return withFallback(
      `daily bars for ${ticker}`,
      this.logger,
      this.primary,
      this.secondary,
      (a) => a.fetchDailyBars(ticker, from, to),
    );
  }
}

// ── Ticker universe ─────────────────────────────────────────────────────────

export class PolygonTickerUniverseAdapter implements TickerUniverseAdapter {
  readonly sourceName = "polygon";
  constructor(private readonly polygon: PolygonService) {}

  async fetchAllTickers(
    activeOnly: boolean,
  ): Promise<AdapterResult<CanonicalTickerRef[]>> {
    const rows = await this.polygon.getAllTickers(activeOnly);
    return {
      data: rows
        .filter((t) => t.ticker)
        .map((t) => ({
          ticker: t.ticker,
          name: t.name ?? null,
          market: t.market ?? null,
          locale: t.locale ?? null,
          primaryExchange: t.primary_exchange ?? null,
          type: t.type ?? null,
          active: t.active,
          currencyName: t.currency_name ?? null,
          cik: t.cik ?? null,
          compositeFigi: t.composite_figi ?? null,
          shareClassFigi: t.share_class_figi ?? null,
        })),
      source: this.sourceName,
      warnings: [],
    };
  }
}

export class CompositeTickerUniverseAdapter implements TickerUniverseAdapter {
  private readonly logger = new Logger(CompositeTickerUniverseAdapter.name);
  readonly sourceName: string;

  constructor(
    private readonly primary: TickerUniverseAdapter,
    private readonly secondary: TickerUniverseAdapter | null,
  ) {
    this.sourceName = secondary
      ? `${primary.sourceName}(fallback:${secondary.sourceName})`
      : primary.sourceName;
  }

  fetchAllTickers(activeOnly: boolean) {
    return withFallback(
      "ticker universe",
      this.logger,
      this.primary,
      this.secondary,
      (a) => a.fetchAllTickers(activeOnly),
    );
  }
}

// ── Financials ──────────────────────────────────────────────────────────────

const POLYGON_VX_FINANCIALS_WARNING = {
  code: "STALE_DATA" as const,
  message:
    "Served by /vX/reference/financials — Polygon's EXPERIMENTAL namespace. The replacement (/stocks/financials/v1/*) needs Advanced or the Financials add-on, so this path cannot be upgraded on Starter and may break without deprecation notice.",
};

export class PolygonFinancialsAdapter implements FinancialsAdapter {
  readonly sourceName = "polygon";
  constructor(private readonly polygon: PolygonService) {}

  get requestDelayMs() {
    return this.polygon.requestDelayMs;
  }

  async fetchIncomeStatements(
    ticker: string,
    timeframe: string,
    limit: number,
  ): Promise<AdapterResult<CanonicalIncomeStatement[]>> {
    return {
      data: await this.polygon.getIncomeStatements(ticker, timeframe, limit),
      source: this.sourceName,
      warnings: [POLYGON_VX_FINANCIALS_WARNING],
    };
  }

  /** One request returns all three statements, so `incomeOnly` saves nothing here. */
  async fetchFinancialStatements(
    ticker: string,
    timeframe: FinancialsTimeframe,
    limit: number,
  ): Promise<AdapterResult<CanonicalFinancialStatement[]>> {
    return {
      data: await this.polygon.getFinancialStatements(ticker, timeframe, limit),
      source: this.sourceName,
      warnings: [POLYGON_VX_FINANCIALS_WARNING],
    };
  }
}

export class FmpFinancialsAdapter implements FinancialsAdapter {
  readonly sourceName = "fmp";
  constructor(private readonly fmp: FmpService) {}

  get requestDelayMs() {
    return 50;
  }

  async fetchIncomeStatements(
    ticker: string,
    timeframe: string,
    limit: number,
  ): Promise<AdapterResult<CanonicalIncomeStatement[]>> {
    const data = await this.fmp.getIncomeStatements(ticker, timeframe, limit);
    return {
      data,
      source: this.sourceName,
      warnings: [],
    };
  }
}

export class CompositeFinancialsAdapter implements FinancialsAdapter {
  private readonly logger = new Logger(CompositeFinancialsAdapter.name);
  readonly sourceName: string;

  constructor(
    private readonly primary: FinancialsAdapter,
    private readonly secondary: FinancialsAdapter | null,
  ) {
    this.sourceName = secondary
      ? `${primary.sourceName}(fallback:${secondary.sourceName})`
      : primary.sourceName;
  }

  get requestDelayMs() {
    return this.primary.requestDelayMs;
  }

  // Both methods treat a resolved-but-EMPTY primary as a soft failure: Polygon
  // answers 200 with zero periods for foreign private issuers (20-F/6-K filers
  // such as GAUZ), which a throw-only fallback would never route to FMP.
  fetchIncomeStatements(ticker: string, timeframe: string, limit: number) {
    return withFallback(
      `income statements for ${ticker}`,
      this.logger,
      this.primary,
      this.secondary,
      (a) => a.fetchIncomeStatements(ticker, timeframe, limit),
      (r) => r.data.length === 0,
    );
  }

  fetchFinancialStatements(
    ticker: string,
    timeframe: FinancialsTimeframe,
    limit: number,
    opts?: { incomeOnly?: boolean },
  ) {
    return withFallback(
      `${timeframe} financial statements for ${ticker}`,
      this.logger,
      this.primary,
      this.secondary,
      (a) => a.fetchFinancialStatements(ticker, timeframe, limit, opts),
      (r) => r.data.length === 0,
    );
  }
}
