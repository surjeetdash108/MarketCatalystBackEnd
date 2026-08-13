import { Controller, Get, Header, Inject } from '@nestjs/common';
import { SECTORS_ADAPTER, type SectorsAdapter } from '../adapters/types';

function slug(sector: string): string {
  return sector
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * GET /market-data/sectors — backs the Market Heatmap screen's per-sector
 * `pctChange`. Calls Polygon directly on every request (no Firestore cache,
 * no sync job) — mirrors sectors.job.ts's fetch, minus the persistence step.
 */
@Controller('market-data')
export class SectorsController {
  constructor(
    @Inject(SECTORS_ADAPTER) private readonly sectorsAdapter: SectorsAdapter,
  ) {}

  @Get('sectors')
  @Header('Cache-Control', 'no-store')
  async sectors() {
    const result = await this.sectorsAdapter.fetchSectorPerformance();
    return result.data.map((row) => ({
      id: slug(row.sector),
      sector: row.sector,
      exchange: row.exchange,
      pctChange: Math.round(row.averageChange * 100) / 100,
      asOfDate: row.date,
      source: result.source,
      warnings: result.warnings,
      updatedAt: new Date().toISOString(),
    }));
  }
}
