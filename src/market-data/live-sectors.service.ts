import { Inject, Injectable } from "@nestjs/common";
import { SECTORS_ADAPTER, type SectorsAdapter } from "../adapters/types";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the `sectors` sync job + Firestore cache. Calls the
 * SectorsAdapter (11 sector-ETF quotes via Polygon) on demand and maps the
 * result to the exact `SectorApiDoc` shape the Heatmap screen already reads
 * (`{ sector, exchange, pctChange, asOfDate, source }`) — see the deleted
 * `sync/sectors.job.ts` for the original mapping this preserves.
 *
 * Wrapped in a 5s coalescer so concurrent Heatmap/Dashboard loads share one
 * upstream fetch instead of firing 11 Polygon calls per viewer.
 */
export interface SectorApiRow {
  sector: string;
  exchange: string;
  pctChange: number;
  asOfDate: string;
  source: string;
}

@Injectable()
export class LiveSectorsService {
  private readonly coalescer = new LiveCoalescer(5_000);

  constructor(
    @Inject(SECTORS_ADAPTER) private readonly sectors: SectorsAdapter,
  ) {}

  async getSectors(): Promise<SectorApiRow[]> {
    return this.coalescer.run("sectors", async () => {
      const result = await this.sectors.fetchSectorPerformance();
      return result.data.map((row) => ({
        sector: row.sector,
        exchange: row.exchange,
        pctChange: Math.round(row.averageChange * 100) / 100,
        asOfDate: row.date,
        source: result.source,
      }));
    });
  }
}
