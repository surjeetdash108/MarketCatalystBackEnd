import { Injectable } from '@nestjs/common';
import { FmpService } from '../vendors/fmp/fmp.service';
import {
  AdapterResult,
  capBucket,
  MoverEnrichment,
  MoverEnrichmentAdapter,
} from './types';

@Injectable()
export class FmpMoverEnrichmentAdapter implements MoverEnrichmentAdapter {
  readonly sourceName = 'fmp';

  constructor(private readonly fmp: FmpService) {}

  async enrichTicker(
    ticker: string,
  ): Promise<AdapterResult<MoverEnrichment> | null> {
    const profile = await this.fmp.getProfile(ticker);
    if (!profile) return null;
    const data: MoverEnrichment = {
      name: profile.companyName ?? null,
      sector: profile.sector ?? null,
      cap: capBucket(profile.marketCap ?? null),
    };
    return { data, source: this.sourceName, warnings: [] };
  }
}
