import { Controller, Get } from "@nestjs/common";
import { LiveCompaniesService } from "./live-companies.service";

/**
 * GET /market-data/companies — the bulk per-ticker reference (name/sector/price/
 * pctChange/marketCap) shared by Movers, Heatmap, Themes, Screener, watchlist/
 * portfolio and the Dashboard. Served LIVE per request over a dynamically
 * resolved universe (tape + watchlists + holdings + usage) — no Firestore
 * cache, no sync job; coalesced in the service.
 *
 * Whole-universe COMPUTED metrics (RS/tech ratings, technicals, growth, sector
 * ranks, peers) are null here — they're an inherent batch and are filled
 * on-demand per ticker by GET /live/company when a stock is opened.
 */
@Controller("market-data")
export class CompaniesController {
  constructor(private readonly liveCompanies: LiveCompaniesService) {}

  @Get("companies")
  async companies() {
    return this.liveCompanies.getCompanies();
  }
}
