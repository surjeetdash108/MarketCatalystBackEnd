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
  COMPANY_PROFILE_ADAPTER,
  MOVERS_ADAPTER,
  MOVER_ENRICHMENT_ADAPTER,
  NEWS_ADAPTER,
} from './types';

const FMP_POLYGON_SOURCES = ['fmp', 'polygon', 'none'];
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
        const mode = parseSource(config, 'NEWS_SOURCE', NEWS_SOURCES, 'aggregate');
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
  ],
  exports: [
    COMPANY_PROFILE_ADAPTER,
    MOVERS_ADAPTER,
    MOVER_ENRICHMENT_ADAPTER,
    NEWS_ADAPTER,
  ],
})
export class AdaptersModule {}
