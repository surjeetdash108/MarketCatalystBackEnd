import { Inject, Injectable, Logger } from "@nestjs/common";
import { SECTORS_ADAPTER, type SectorsAdapter } from "../adapters/types";

function slug(sector: string): string {
  return sector
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

@Injectable()
export class SectorsJob {
  private readonly logger = new Logger(SectorsJob.name);

  constructor(
    @Inject(SECTORS_ADAPTER) private readonly sectors: SectorsAdapter,
  ) {}

  /**
   * Live-direct: fetch + shape per-sector performance WITHOUT writing Firestore,
   * returning the exact `{id, ...data}` shape the `sectors` collection read used
   * to yield. Backs GET /market-data/sectors.
   */
  async fetchLive(): Promise<Record<string, unknown>[]> {
    const { current } = await this.buildDocs();
    return current.map((d) => ({ id: d.id, ...d.data }));
  }

  private async buildDocs(): Promise<{
    current: { id: string; data: Record<string, unknown> }[];
    history: { id: string; data: Record<string, unknown> }[];
  }> {
    const result = await this.sectors.fetchSectorPerformance();
    const rows = result.data;
    const source = result.source;
    if (result.warnings.length > 0) {
      this.logger.log(
        `sectors: ${result.warnings.map((w) => w.code).join(", ")}`,
      );
    }
    const current: { id: string; data: Record<string, unknown> }[] = [];
    const history: { id: string; data: Record<string, unknown> }[] = [];
    for (const row of rows) {
      const doc = {
        sector: row.sector,
        exchange: row.exchange,
        pctChange: Math.round(row.averageChange * 100) / 100,
        asOfDate: row.date,
        source,
        warnings: result.warnings,
        updatedAt: new Date().toISOString(),
      };
      current.push({ id: slug(row.sector), data: doc });
      history.push({ id: `${row.date}_${slug(row.sector)}`, data: doc });
    }
    return { current, history };
  }
}
