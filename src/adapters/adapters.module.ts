import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PolygonModule } from "../vendors/polygon/polygon.module";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FmpModule } from "../vendors/fmp/fmp.module";
import { FmpService } from "../vendors/fmp/fmp.service";
import { FmpEarningsEstimatesAdapter } from "./earnings-estimates.adapter";
import { FmpAnalystRatingsAdapter } from "./analyst-ratings.adapter";
import { CompositeCompanyProfileAdapter } from "./composite-company-profile.adapter";
import { CompositeMoverEnrichmentAdapter } from "./composite-mover-enrichment.adapter";
import { CompositeMoversAdapter } from "./composite-movers.adapter";
import { CompositeNewsAdapter } from "./composite-news.adapter";
import { PolygonCompanyProfileAdapter } from "./polygon-company-profile.adapter";
import { PolygonMoverEnrichmentAdapter } from "./polygon-mover-enrichment.adapter";
import { PolygonMoversAdapter } from "./polygon-movers.adapter";
import { PolygonNewsAdapter } from "./polygon-news.adapter";
import { TradingViewNewsAdapter } from "./tradingview-news.adapter";
import { FmpNewsAdapter } from "./fmp-news.adapter";
import {
  CompositeDividendsAdapter,
  PolygonDividendsAdapter,
} from "./dividends.adapters";
import { CompositeIposAdapter, PolygonIposAdapter } from "./ipos.adapters";
import {
  CompositeSectorsAdapter,
  PolygonSectorsAdapter,
  FmpSectorsAdapter,
} from "./sectors.adapters";
import {
  CompositeFinancialsAdapter,
  CompositeMarketBarsAdapter,
  CompositeTickerUniverseAdapter,
  PolygonFinancialsAdapter,
  PolygonMarketBarsAdapter,
  PolygonTickerUniverseAdapter,
} from "./market-data.adapters";
import { CompositeQuoteAdapter, PolygonQuoteAdapter } from "./quote.adapters";
import {
  COMPANY_PROFILE_ADAPTER,
  DIVIDENDS_ADAPTER,
  FINANCIALS_ADAPTER,
  MARKET_BARS_ADAPTER,
  TICKER_UNIVERSE_ADAPTER,
  IPOS_ADAPTER,
  MOVERS_ADAPTER,
  MOVER_ENRICHMENT_ADAPTER,
  NEWS_ADAPTER,
  NEWS_FMP_ADAPTER,
  NEWS_TRADINGVIEW_ADAPTER,
  QUOTE_ADAPTER,
  SECTORS_ADAPTER,
  EARNINGS_ESTIMATES_ADAPTER,
  ANALYST_RATINGS_ADAPTER,
} from "./types";

// Every composite is Polygon-only. The list is where a second vendor becomes
// selectable again — add its name here and one entry to the bySource map.
const POLYGON_ONLY_SOURCES = ["polygon", "none"];
/** Domains where FMP is a selectable primary/fallback (has an adapter here). */
const POLYGON_OR_FMP_SOURCES = ["polygon", "fmp", "none"];

function parseSource(config, key, validSources, fallbackDefault) {
  const raw = config.get(key, fallbackDefault);
  if (!validSources.includes(raw)) {
    throw new Error(
      `Unknown ${key}="${raw}" — expected one of: ${validSources.join(", ")}`,
    );
  }
  return raw;
}

/**
 * Resolves a `<NAME>_SOURCE` / `<NAME>_FALLBACK_SOURCE` pair into a composite.
 *
 * Setting the fallback to "none" (or to the same vendor as the primary) yields a
 * single-source composite — which is how you run one vendor exclusively WITHOUT
 * losing the ability to switch vendors later, since every implementation stays
 * registered and selectable by env var.
 */
function buildComposite(
  config,
  name: string,
  validSources: string[],
  defaults: { primary: string; fallback: string },
  bySource: Record<string, () => unknown>,
  Composite: new (primary: any, secondary: any) => unknown,
) {
  const primarySource = parseSource(
    config,
    `${name}_SOURCE`,
    validSources,
    defaults.primary,
  );
  if (primarySource === "none") {
    throw new Error(
      `${name}_SOURCE cannot be "none" — a primary source is required`,
    );
  }
  const fallbackSource = parseSource(
    config,
    `${name}_FALLBACK_SOURCE`,
    validSources,
    defaults.fallback,
  );
  const fallback =
    fallbackSource === "none" || fallbackSource === primarySource
      ? null
      : bySource[fallbackSource]();
  return new Composite(bySource[primarySource](), fallback);
}

@Module({
  imports: [PolygonModule, FmpModule],
  providers: [
    PolygonCompanyProfileAdapter,
    PolygonMoversAdapter,
    PolygonMoverEnrichmentAdapter,
    PolygonNewsAdapter,
    {
      provide: COMPANY_PROFILE_ADAPTER,
      inject: [ConfigService, PolygonService, FmpService],
      useFactory: (config, polygon, fmp: FmpService) =>
        buildComposite(
          config,
          "COMPANY_PROFILE",
          POLYGON_ONLY_SOURCES,
          { primary: "polygon", fallback: "none" },
          {
            polygon: () => new PolygonCompanyProfileAdapter(polygon, fmp),
            none: () => null,
          },
          CompositeCompanyProfileAdapter,
        ),
    },
    {
      provide: MOVERS_ADAPTER,
      inject: [ConfigService, PolygonService],
      useFactory: (config, polygon) =>
        buildComposite(
          config,
          "MOVERS",
          POLYGON_ONLY_SOURCES,
          { primary: "polygon", fallback: "none" },
          {
            polygon: () => new PolygonMoversAdapter(polygon),
            none: () => null,
          },
          CompositeMoversAdapter,
        ),
    },
    {
      provide: MOVER_ENRICHMENT_ADAPTER,
      inject: [ConfigService, PolygonService, FmpService],
      useFactory: (config, polygon, fmp: FmpService) =>
        buildComposite(
          config,
          "MOVER_ENRICHMENT",
          POLYGON_ONLY_SOURCES,
          { primary: "polygon", fallback: "none" },
          {
            polygon: () => new PolygonMoverEnrichmentAdapter(polygon, fmp),
            none: () => null,
          },
          CompositeMoverEnrichmentAdapter,
        ),
    },
    {
      // Third news provider (§1). Constructed always so the pipeline shape is
      // fixed, but INERT until TRADINGVIEW_NEWS_URL is set — see the adapter
      // for why it reads a licensed feed rather than scraping the site.
      provide: NEWS_TRADINGVIEW_ADAPTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new TradingViewNewsAdapter(
          String(config.get("TRADINGVIEW_NEWS_URL", "")).trim() || null,
          String(config.get("TRADINGVIEW_NEWS_KEY", "")).trim() || null,
        ),
    },
    {
      provide: NEWS_ADAPTER,
      inject: [PolygonService],
      useFactory: (polygon) =>
        new CompositeNewsAdapter(new PolygonNewsAdapter(polygon), null),
    },
    {
      // Optional FMP news, merged with Polygon by news.job. Defaults to "none";
      // set NEWS_FMP_SOURCE=fmp (and FMP_API_KEY) to enable the second feed.
      provide: NEWS_FMP_ADAPTER,
      inject: [ConfigService, FmpService],
      useFactory: (config: ConfigService, fmp: FmpService) => {
        const source = parseSource(config, "NEWS_FMP_SOURCE", ["fmp", "none"], "none");
        return source === "fmp" ? new FmpNewsAdapter(fmp) : null;
      },
    },
    {
      provide: DIVIDENDS_ADAPTER,
      inject: [ConfigService, PolygonService],
      useFactory: (config, polygon) =>
        buildComposite(
          config,
          "DIVIDENDS",
          POLYGON_ONLY_SOURCES,
          { primary: "polygon", fallback: "none" },
          {
            polygon: () => new PolygonDividendsAdapter(polygon),
            none: () => null,
          },
          CompositeDividendsAdapter,
        ),
    },
    {
      provide: IPOS_ADAPTER,
      inject: [ConfigService, PolygonService],
      useFactory: (config, polygon) =>
        buildComposite(
          config,
          "IPOS",
          POLYGON_ONLY_SOURCES,
          { primary: "polygon", fallback: "none" },
          {
            polygon: () => new PolygonIposAdapter(polygon),
            none: () => null,
          },
          CompositeIposAdapter,
        ),
    },
    {
      provide: SECTORS_ADAPTER,
      inject: [ConfigService, PolygonService, FmpService],
      useFactory: (config, polygon, fmp: FmpService) =>
        buildComposite(
          config,
          "SECTORS",
          // FMP is selectable here (real aggregates) — SECTORS_SOURCE=fmp or
          // SECTORS_FALLBACK_SOURCE=fmp. Defaults stay polygon/none.
          POLYGON_OR_FMP_SOURCES,
          { primary: "polygon", fallback: "none" },
          {
            polygon: () => new PolygonSectorsAdapter(polygon),
            fmp: () => new FmpSectorsAdapter(fmp),
            none: () => null,
          },
          CompositeSectorsAdapter,
        ),
    },
    {
      provide: QUOTE_ADAPTER,
      inject: [ConfigService, PolygonService],
      useFactory: (config, polygon) =>
        buildComposite(
          config,
          "QUOTE",
          POLYGON_ONLY_SOURCES,
          { primary: "polygon", fallback: "none" },
          {
            polygon: () => new PolygonQuoteAdapter(polygon),
            none: () => null,
          },
          CompositeQuoteAdapter,
        ),
    },
    {
      provide: MARKET_BARS_ADAPTER,
      inject: [ConfigService, PolygonService],
      useFactory: (config, polygon) =>
        buildComposite(
          config,
          "MARKET_BARS",
          POLYGON_ONLY_SOURCES,
          { primary: "polygon", fallback: "none" },
          {
            polygon: () => new PolygonMarketBarsAdapter(polygon),
            none: () => null,
          },
          CompositeMarketBarsAdapter,
        ),
    },
    {
      provide: TICKER_UNIVERSE_ADAPTER,
      inject: [ConfigService, PolygonService],
      useFactory: (config, polygon) =>
        buildComposite(
          config,
          "TICKER_UNIVERSE",
          POLYGON_ONLY_SOURCES,
          { primary: "polygon", fallback: "none" },
          {
            polygon: () => new PolygonTickerUniverseAdapter(polygon),
            none: () => null,
          },
          CompositeTickerUniverseAdapter,
        ),
    },
    {
      provide: FINANCIALS_ADAPTER,
      inject: [ConfigService, PolygonService],
      useFactory: (config, polygon) =>
        buildComposite(
          config,
          "FINANCIALS",
          POLYGON_ONLY_SOURCES,
          { primary: "polygon", fallback: "none" },
          {
            polygon: () => new PolygonFinancialsAdapter(polygon),
            none: () => null,
          },
          CompositeFinancialsAdapter,
        ),
    },
    {
      // Opt-in estimates seam. Defaults to "none" → null, so the earnings job is
      // untouched until EARNINGS_ESTIMATES_SOURCE=fmp (and FMP_API_KEY) are set.
      provide: EARNINGS_ESTIMATES_ADAPTER,
      inject: [ConfigService, FmpService],
      useFactory: (config: ConfigService, fmp: FmpService) => {
        const source = parseSource(
          config,
          "EARNINGS_ESTIMATES_SOURCE",
          ["fmp", "none"],
          "none",
        );
        return source === "fmp" ? new FmpEarningsEstimatesAdapter(fmp) : null;
      },
    },
    {
      // Opt-in analyst-ratings seam. Defaults to "none" → null, so the
      // analyst-actions job stays a no-op until ANALYST_SOURCE=fmp.
      provide: ANALYST_RATINGS_ADAPTER,
      inject: [ConfigService, FmpService],
      useFactory: (config: ConfigService, fmp: FmpService) => {
        const source = parseSource(
          config,
          "ANALYST_SOURCE",
          ["fmp", "none"],
          "none",
        );
        return source === "fmp" ? new FmpAnalystRatingsAdapter(fmp) : null;
      },
    },
  ],
  exports: [
    COMPANY_PROFILE_ADAPTER,
    MOVERS_ADAPTER,
    MOVER_ENRICHMENT_ADAPTER,
    NEWS_ADAPTER,
    NEWS_FMP_ADAPTER,
    DIVIDENDS_ADAPTER,
    IPOS_ADAPTER,
    SECTORS_ADAPTER,
    QUOTE_ADAPTER,
    MARKET_BARS_ADAPTER,
    TICKER_UNIVERSE_ADAPTER,
    FINANCIALS_ADAPTER,
    EARNINGS_ESTIMATES_ADAPTER,
    ANALYST_RATINGS_ADAPTER,
  ],
})
export class AdaptersModule {}
