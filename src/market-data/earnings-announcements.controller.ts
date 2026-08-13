import { Controller, Get, Header } from "@nestjs/common";
import { Edgar8KJob } from "../sync/edgar-8k.job";

/**
 * GET /market-data/earnings-announcements — SEC-EDGAR 8-K item-2.02 earnings
 * announcements with session (BMO/AMC) and post-announcement price reaction.
 * Backs the recap's "earnings movers" and the earnings detail's
 * Session/Reaction rows. Live-direct: swept per request from SEC-EDGAR via the
 * source job, no Firestore cache.
 */
@Controller("market-data")
export class EarningsAnnouncementsController {
  constructor(private readonly job: Edgar8KJob) {}

  @Get("earnings-announcements")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async earningsAnnouncements() {
    return this.job.fetchEarningsAnnouncementsLive();
  }
}
