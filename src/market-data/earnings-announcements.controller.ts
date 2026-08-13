import { Controller, Get, Header } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";

/**
 * GET /market-data/earnings-announcements — SEC-EDGAR 8-K item-2.02 earnings
 * announcements with session (BMO/AMC) and post-announcement price reaction
 * (`earnings_announcements`, written by the `edgar-8k` job). Backs the recap's
 * "earnings movers" and the earnings detail's Session/Reaction rows.
 */
@Controller("market-data")
export class EarningsAnnouncementsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("earnings-announcements")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async earningsAnnouncements() {
    await this.marketData.ensureFresh("edgar-8k");
    const { earnings_announcements } = await this.cached.get([
      "earnings_announcements",
    ]);
    return earnings_announcements;
  }
}
