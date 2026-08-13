import { Controller, Get } from "@nestjs/common";
import { Edgar8kFeedService } from "./edgar-8k-feed.service";

/**
 * GET /market-data/earnings-announcements — SEC-EDGAR 8-K item-2.02 earnings
 * announcements with session (BMO/AMC), backing the recap's "earnings movers"
 * and the earnings detail's Session/Reaction rows. Served LIVE per request from
 * EDGAR's getcurrent 8-K stream (filtered to item 2.02) via the shared
 * Edgar8kFeedService — no Firestore cache, no sync job.
 *
 * `reactionPct` (post-announcement price move) is null: it needs accumulated
 * bars no single live call provides — the UI renders null as "—".
 */
@Controller("market-data")
export class EarningsAnnouncementsController {
  constructor(private readonly feed: Edgar8kFeedService) {}

  @Get("earnings-announcements")
  async earningsAnnouncements() {
    const { announcements } = await this.feed.fetchAll();
    return announcements.map((a) => ({
      id: `${a.ticker}_${a.announceDate}`,
      ticker: a.ticker,
      companyName: a.companyName,
      announceDate: a.announceDate,
      session: a.session,
      reactionPct: null,
      accessionNumber: a.accessionNumber,
      url: a.url,
    }));
  }
}
