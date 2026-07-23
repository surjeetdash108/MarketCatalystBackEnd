import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FinnhubModule } from '../vendors/finnhub/finnhub.module';
import { FinnhubService } from '../vendors/finnhub/finnhub.service';
import { FmpModule } from '../vendors/fmp/fmp.module';
import { FmpService } from '../vendors/fmp/fmp.service';
import { PolygonModule } from '../vendors/polygon/polygon.module';
import { PolygonService } from '../vendors/polygon/polygon.service';
import { AggregatingNewsAdapter } from './aggregating-news.adapter';
import { CompositeCompanyProfileAdapter } from './composite-company-profile.adapter';
import { CompositeMoverEnrichmentAdapter } from './composite-mover-enrichment.adapter';
import { CompositeMoversAdapter } from './composite-movers.adapter';
import { CompositeNewsAdapter } from './composite-news.adapter';
import { FinnhubNewsAdapter } from './finnhub-news.adapter';
import { FmpCompanyProfileAdapter } from './fmp-company-profile.adapter';
import { FmpMoverEnrichmentAdapter } from './fmp-mover-enrichment.adapter';
import { FmpMoversAdapter } from './fmp-movers.adapter';
import { PolygonCompanyProfileAdapter } from './polygon-company-profile.adapter';
import { PolygonMoverEnrichmentAdapter } from './polygon-mover-enrichment.adapter';
import { PolygonMoversAdapter } from './polygon-movers.adapter';
import { PolygonNewsAdapter } from './polygon-news.adapter';
import {
  CompositeDividendsAdapter,
  FmpDividendsAdapter,
  PolygonDividendsAdapter,
} from './dividends.adapters';
import {
  CompositeIposAdapter,
  FinnhubIposAdapter,
  PolygonIposAdapter,
} from './ipos.adapters';
import {
  CompositeSectorsAdapter,
  FmpSectorsAdapter,
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

const FMP_POLYGON_SOURCES = ['fmp', 'polygon', 'none'];
const POLYGON_FINNHUB_SOURCES = ['polygon', 'finnhub', 'none'];
// Only Polygon implements these three today. The list is where a second vendor
// becomes selectable — add its name here and one entry to the bySource map.
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
  imports: [FmpModule, PolygonModule, FinnhubModule],
  providers: [
    FmpCompanyProfileAdapter,
    PolygonCompanyProfileAdapter,
    FmpMoversAdapter,
    PolygonMoversAdapter,
    FmpMoverEnrichmentAdapter,
    PolygonMoverEnrichmentAdapter,
    PolygonNewsAdapter,
    FinnhubNewsAdapter,
    {
      provide: COMPANY_PROFILE_ADAPTER,
      inject: [ConfigService, FmpService, PolygonService],
      useFactory: (config, fmp, polygon) => {
        const primarySource = parseSource(
          config,
          'COMPANY_PROFILE_SOURCE',
          FMP_POLYGON_SOURCES,
          'fmp',
        );
        const fallbackSource = parseSource(
          config,
          'COMPANY_PROFILE_FALLBACK_SOURCE',
          FMP_POLYGON_SOURCES,
          'polygon',
        );
        const bySource = {
          fmp: () => new FmpCompanyProfileAdapter(fmp),
          polygon: () => new PolygonCompanyProfileAdapter(polygon),
          none: () => null,
        };
        if (primarySource === 'none') {
          throw new Error(
            'COMPANY_PROFILE_SOURCE cannot be "none" — a primary source is required',
          );
        }
        const primary = bySource[primarySource]();
        const fallback =
          fallbackSource === 'none' || fallbackSource === primarySource
            ? null
            : bySource[fallbackSource]();
        return new CompositeCompanyProfileAdapter(primary, fallback);
      },
    },
    {
      provide: MOVERS_ADAPTER,
      inject: [ConfigService, FmpService, PolygonService],
      useFactory: (config, fmp, polygon) => {
        const primarySource = parseSource(
          config,
          'MOVERS_SOURCE',
          FMP_POLYGON_SOURCES,
          'polygon',
        );
        const fallbackSource = parseSource(
          config,
          'MOVERS_FALLBACK_SOURCE',
          FMP_POLYGON_SOURCES,
          'fmp',
        );
        const bySource = {
          fmp: () => new FmpMoversAdapter(fmp),
          polygon: () => new PolygonMoversAdapter(polygon),
          none: () => null,
        };
        if (primarySource === 'none') {
          throw new Error(
            'MOVERS_SOURCE cannot be "none" — a primary source is required',
          );
        }
        const primary = bySource[primarySource]();
        const fallback =
          fallbackSource === 'none' || fallbackSource === primarySource
            ? null
            : bySource[fallbackSource]();
        return new CompositeMoversAdapter(primary, fallback);
      },
    },
    {
      provide: MOVER_ENRICHMENT_ADAPTER,
      inject: [ConfigService, FmpService, PolygonService],
      useFactory: (config, fmp, polygon) => {
        const primarySource = parseSource(
          config,
          'MOVER_ENRICHMENT_SOURCE',
          FMP_POLYGON_SOURCES,
          'fmp',
        );
        const fallbackSource = parseSource(
          config,
          'MOVER_ENRICHMENT_FALLBACK_SOURCE',
          FMP_POLYGON_SOURCES,
          'polygon',
        );
        const bySource = {
          fmp: () => new FmpMoverEnrichmentAdapter(fmp),
          polygon: () => new PolygonMoverEnrichmentAdapter(polygon),
          none: () => null,
        };
        if (primarySource === 'none') {
          throw new Error(
            'MOVER_ENRICHMENT_SOURCE cannot be "none" — a primary source is required',
          );
        }
        const primary = bySource[primarySource]();
        const fallback =
          fallbackSource === 'none' || fallbackSource === primarySource
            ? null
            : bySource[fallbackSource]();
        return new CompositeMoverEnrichmentAdapter(primary, fallback);
      },
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
      inject: [ConfigService, FmpService, PolygonService],
      useFactory: (config, fmp, polygon) =>
        buildComposite(
          config,
          'DIVIDENDS',
          FMP_POLYGON_SOURCES,
          { primary: 'polygon', fallback: 'fmp' },
          {
            polygon: () => new PolygonDividendsAdapter(polygon),
            fmp: () => new FmpDividendsAdapter(fmp),
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
      inject: [ConfigService, FmpService, PolygonService],
      useFactory: (config, fmp, polygon) =>
        buildComposite(
          config,
          'SECTORS',
          FMP_POLYGON_SOURCES,
          { primary: 'polygon', fallback: 'fmp' },
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
