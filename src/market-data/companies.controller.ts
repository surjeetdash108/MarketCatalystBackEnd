import { Controller, Get, Header } from "@nestjs/common";
import { CompaniesJob } from "../sync/companies.job";

/**
 * GET /market-data/companies — the bulk `companies` collection (per-ticker
 * price/pctChange/marketCap/rvol), shared by Movers (rvol enrichment),
 * Heatmap (tile price/marketCap) and, later, Dashboard. Live-direct: sweeps the
 * whole active universe per request via the source job, no Firestore cache.
 * (Heavy per-ticker sweep — accepted as slow live.)
 */
@Controller("market-data")
export class CompaniesController {
  constructor(private readonly job: CompaniesJob) {}

  @Get("companies")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async companies() {
    return this.job.fetchLive();
  }
}
