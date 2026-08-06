import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FinnhubModule } from '../vendors/finnhub/finnhub.module';
import { FinnhubService } from '../vendors/finnhub/finnhub.service';
import { PolygonModule } from '../vendors/polygon/polygon.module';
import { PolygonService } from '../vendors/polygon/polygon.service';
import { AggregatingNewsAdapter } from './aggregating-news.adapter';
import { CompositeCompanyProfileAdapter } from './composite-company-profile.adapter';
import { CompositeMoverEnrichmentAdapter } from './composite-mover-enrichment.adapter';
import { CompositeMoversAdapter } from './composite-movers.adapter';
import { CompositeNewsAdapter } from './composite-news.adapter';
import { FinnhubNewsAdapter } from './finnhub-news.adapter';
import { PolygonCompanyProfileAdapter } from './polygon-company-profile.adapter';
import { PolygonMoverEnrichmentAdapter } from './polygon-mover-enrichment.adapter';
import { PolygonMoversAdapter } from './polygon-movers.adapter';
import { PolygonNewsAdapter } from './polygon-news.adapter';
import {
  CompositeDividendsAdapter,
  PolygonDividendsAdapter,
} from './dividends.adapters';
import {
  CompositeIposAdapter,
  FinnhubIposAdapter,
  PolygonIposAdapter,
} from './ipos.adapters';
import {
  CompositeSectorsAdapter,
  PolygonSectorsAdapter,
} from './sectors.adapters';
import {
  CompositeFinancialsAdapter,
  CompositeMarketBarsAdapter,
  CompositeTickerUniverseAdapter,
  PolygonFinancialsAdapter,
  PolygonMarketBarsAdapter,
  PolygonTickerUniverseAdapter,
} from './market-data.adapters';
import {
  CompositeQuoteAdapter,
  FinnhubQuoteAdapter,
  PolygonQuoteAdapter,
} from './quote.adapters';
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
  QUOTE_ADAPTER,
  SECTORS_ADAPTER,
} from './types';

const POLYGON_FINNHUB_SOURCES = ['polygon', 'finnhub', 'none'];
// Company profile, movers, mover enrichment, dividends and sectors are
// Polygon-only. The list is where a second vendor becomes selectable again —
// add its name here and one entry to the bySource map.
const POLYGON_ONLY_SOURCES = ['polygon', 'none'];
const NEWS_SOURCES = ['polygon', 'finnhub', 'aggregate', 'none'];
const NEWS_SINGLE_SOURCES = ['polygon', 'finnhub', 'none'];

function parseSource(config, key, validSources, fallbackDefault) {
  const raw = config.get(key, fallbackDefault);
  if (!validSources.includes(raw)) {
    throw new Error(
      `Unknown ${key}="${raw}" — expected one of: ${validSources.join(', ')}`,
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
  if (primarySource === 'none') {
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
    fallbackSource === 'none' || fallbackSource === primarySource
      ? null
      : bySource[fallbackSource]();
  return new Composite(bySource[primarySource](), fallback);
}

@Module({
  imports: [PolygonModule, FinnhubModule],
  providers: [
    PolygonCompanyProfileAdapter,
    PolygonMoversAdapter,
    PolygonMoverEnrichmentAdapter,
    PolygonNewsAdapter,
    FinnhubNewsAdapter,
    {
      provide: COMPANY_PROFILE_ADAPTER,
      inject: [ConfigService, PolygonService],
      useFactory: (config, polygon) =>
        buildComposite(
          config,
          'COMPANY_PROFILE',
          POLYGON_ONLY_SOURCES,
          { primary: 'polygon', fallback: 'none' },
          {
            polygon: () => new PolygonCompanyProfileAdapter(polygon),
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
          'MOVERS',
          POLYGON_ONLY_SOURCES,
          { primary: 'polygon', fallback: 'none' },
          {
            polygon: () => new PolygonMoversAdapter(polygon),
            none: () => null,
          },
          CompositeMoversAdapter,
        ),
    },
    {
      provide: MOVER_ENRICHMENT_ADAPTER,
      inject: [ConfigService, PolygonService],
      useFactory: (config, polygon) =>
        buildComposite(
          config,
          'MOVER_ENRICHMENT',
          POLYGON_ONLY_SOURCES,
          { primary: 'polygon', fallback: 'none' },
          {
            polygon: () => new PolygonMoverEnrichmentAdapter(polygon),
            none: () => null,
          },
          CompositeMoverEnrichmentAdapter,
        ),
    },
    {
      provide: NEWS_ADAPTER,
      inject: [ConfigService, PolygonService, FinnhubService],
      useFactory: (config, polygon, finnhub) => {
        // Default POLYGON, not 'aggregate'. Massive/Polygon is licensed for
        // redistribution; Finnhub is not, so merging Finnhub articles into a
        // feed we serve to users would breach Finnhub's terms. Aggregate stays
        // available for local/dev use but must be opted into explicitly via
        // NEWS_SOURCE — a blank/misconfigured prod deploy now stays Polygon-only.
        const mode = parseSource(config, 'NEWS_SOURCE', NEWS_SOURCES, 'polygon');
        const makePolygon = () => new PolygonNewsAdapter(polygon);
        const makeFinnhub = () => new FinnhubNewsAdapter(finnhub);
        if (mode === 'aggregate') {
          return new AggregatingNewsAdapter([makePolygon(), makeFinnhub()]);
        }
        if (mode === 'none') {
          throw new Error(
            'NEWS_SOURCE cannot be "none" — a primary source is required',
          );
        }
        const bySource = {
          polygon: makePolygon,
          finnhub: makeFinnhub,
          none: () => null,
        };
        const fallbackSource = parseSource(
          config,
          'NEWS_FALLBACK_SOURCE',
          NEWS_SINGLE_SOURCES,
          'finnhub',
        );
        const primary = bySource[mode]();
        const fallback =
          fallbackSource === 'none' || fallbackSource === mode
            ? null
            : bySource[fallbackSource]();
        return new CompositeNewsAdapter(primary, fallback);
      },
    },
    {
      provide: DIVIDENDS_ADAPTER,
      inject: [ConfigService, PolygonService],
      useFactory: (config, polygon) =>
        buildComposite(
          config,
          'DIVIDENDS',
          POLYGON_ONLY_SOURCES,
          { primary: 'polygon', fallback: 'none' },
          {
            polygon: () => new PolygonDividendsAdapter(polygon),
            none: () => null,
          },
          CompositeDividendsAdapter,
        ),
    },
    {
      provide: IPOS_ADAPTER,
      inject: [ConfigService, FinnhubService, PolygonService],
      useFactory: (config, finnhub, polygon) =>
        buildComposite(
          config,
          'IPOS',
          POLYGON_FINNHUB_SOURCES,
          { primary: 'polygon', fallback: 'finnhub' },
          {
            polygon: () => new PolygonIposAdapter(polygon),
            finnhub: () => new FinnhubIposAdapter(finnhub),
            none: () => null,
          },
          CompositeIposAdapter,
        ),
    },
    {
      provide: SECTORS_ADAPTER,
      inject: [ConfigService, PolygonService],
      useFactory: (config, polygon) =>
        buildComposite(
          config,
          'SECTORS',
          POLYGON_ONLY_SOURCES,
          { primary: 'polygon', fallback: 'none' },
          {
            polygon: () => new PolygonSectorsAdapter(polygon),
            none: () => null,
          },
          CompositeSectorsAdapter,
        ),
    },
    {
      provide: QUOTE_ADAPTER,
      inject: [ConfigService, FinnhubService, PolygonService],
      useFactory: (config, finnhub, polygon) =>
        buildComposite(
          config,
          'QUOTE',
          POLYGON_FINNHUB_SOURCES,
          { primary: 'polygon', fallback: 'finnhub' },
          {
            polygon: () => new PolygonQuoteAdapter(polygon),
            finnhub: () => new FinnhubQuoteAdapter(finnhub),
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
          'MARKET_BARS',
          POLYGON_ONLY_SOURCES,
          { primary: 'polygon', fallback: 'none' },
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
          'TICKER_UNIVERSE',
          POLYGON_ONLY_SOURCES,
          { primary: 'polygon', fallback: 'none' },
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
          'FINANCIALS',
          POLYGON_ONLY_SOURCES,
          { primary: 'polygon', fallback: 'none' },
          {
            polygon: () => new PolygonFinancialsAdapter(polygon),
            none: () => null,
          },
          CompositeFinancialsAdapter,
        ),
    },
  ],
  exports: [
    COMPANY_PROFILE_ADAPTER,
    MOVERS_ADAPTER,
    MOVER_ENRICHMENT_ADAPTER,
    NEWS_ADAPTER,
    DIVIDENDS_ADAPTER,
    IPOS_ADAPTER,
    SECTORS_ADAPTER,
    QUOTE_ADAPTER,
    MARKET_BARS_ADAPTER,
    TICKER_UNIVERSE_ADAPTER,
    FINANCIALS_ADAPTER,
  ],
})
export class AdaptersModule {}
