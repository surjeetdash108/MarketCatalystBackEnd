import { Logger } from '@nestjs/common';
import { PolygonService } from '../vendors/polygon/polygon.service';
import type {
  AdapterResult,
  CanonicalSectorPerformance,
  SectorsAdapter,
} from './types';
import { withFallback } from './with-fallback.util';

export class PolygonSectorsAdapter implements SectorsAdapter {
  readonly sourceName = 'polygon';
  constructor(private readonly polygon: PolygonService) {}

  async fetchSectorPerformance(): Promise<
    AdapterResult<CanonicalSectorPerformance[]>
  > {
    const data = await this.polygon.getSectorPerformance();
    // An empty result is a failure, not a valid "no sectors moved" answer —
    // throwing is what lets the composite fall through to the next vendor.
    // This preserves the explicit empty-check the job used to do inline.
    if (data.length === 0) {
      throw new Error('Polygon returned no sector-ETF data');
    }
    return {
      data,
      source: this.sourceName,
      warnings: [
        {
          code: 'STALE_DATA',
          field: 'averageChange',
          message:
            'Derived from 11 SPDR sector ETFs, not true cap-weighted sector aggregates — Massive has no sector endpoint on any tier.',
        },
      ],
    };
  }
}

export class CompositeSectorsAdapter implements SectorsAdapter {
  private readonly logger = new Logger(CompositeSectorsAdapter.name);
  readonly sourceName: string;

  constructor(
    private readonly primary: SectorsAdapter,
    private readonly secondary: SectorsAdapter | null,
  ) {
    this.sourceName = secondary
      ? `${primary.sourceName}(fallback:${secondary.sourceName})`
      : primary.sourceName;
  }

  fetchSectorPerformance() {
    return withFallback(
      'sector performance',
      this.logger,
      this.primary,
      this.secondary,
      (a) => a.fetchSectorPerformance(),
    );
  }
}
