import { Controller, Get } from "@nestjs/common";
import { LiveNewsService } from "./live-news.service";

/**
 * GET /market-data/news — the global "most recent across every ticker" feed that
 * commentary.tsx's Live tab and the Dashboard's Live Market Feed both want.
 * Served LIVE per request from Polygon market-wide reference/news (no Firestore
 * cache, no sync job); coalesced in the service.
 *
 * Per-ticker news (Stock Detail, commentary's per-symbol drawer) is served by
 * GET /live/news?ticker=X (src/live/ondemand.controller.ts) instead.
 */
@Controller("market-data")
export class NewsController {
  constructor(private readonly liveNews: LiveNewsService) {}

  @Get("news")
  async news() {
    return this.liveNews.getNews();
  }
}
