import { Injectable } from '@nestjs/common';
import { PolygonService } from '../vendors/polygon/polygon.service';
import {
  AdapterResult,
  capBucket,
  MoverEnrichment,
  MoverEnrichmentAdapter,
} from './types';

@Injectable()
export class PolygonMoverEnrichmentAdapter implements MoverEnrichmentAdapter {
  readonly sourceName = 'polygon';

  constructor(private readonly polygon: PolygonService) {}

  async enrichTicker(
    ticker: string,
  ): Promise<AdapterResult<MoverEnrichment> | null> {
    const details = await this.polygon.getTickerDetails(ticker);
    if (!details) return null;
    const data: MoverEnrichment = {
      name: details.name ?? null,
      sector: details.sic_description ?? null,
      cap: capBucket(details.market_cap ?? null),
    };
    return {
      data,
      source: this.sourceName,
      warnings: [
        {
          code: 'FIELD_NOT_SUPPORTED',
          field: 'sector',
          message:
            "Polygon reports a free-text SIC description, not FMP's sector taxonomy — treat as approximate.",
        },
      ],
    };
  }
}
