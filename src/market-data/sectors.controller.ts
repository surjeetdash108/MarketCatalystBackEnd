import { Controller, Get, Header } from "@nestjs/common";
import { SectorsJob } from "../sync/sectors.job";

/**
 * GET /market-data/sectors — backs the Market Heatmap screen's per-sector
 * `pctChange` (the `SectorApiDoc` shape). Live-direct: fetched per request from
 * the vendor via the source job, no Firestore cache.
 */
@Controller("market-data")
export class SectorsController {
  constructor(private readonly job: SectorsJob) {}

  @Get("sectors")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async sectors() {
    return this.job.fetchLive();
  }
}
