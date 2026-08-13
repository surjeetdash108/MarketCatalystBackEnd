import { Controller, Get, Header } from "@nestjs/common";
import { NewsJob } from "../sync/news.job";

// A bounded, sorted view of the global news feed. Live-direct: the source job
// sweeps the ticker universe against the news vendor per request — an expensive
// call — so a short in-memory cache is kept here to absorb bursts (the same
// role the previous version's cache played over its Firestore read).
const NEWS_FEED_LIMIT = 60;
const NEWS_FEED_CACHE_MS = 2 * 60_000;

/**
 * GET /market-data/news — the global "most recent across every ticker" feed
 * that commentary.tsx's Live tab and Dashboard's Live Market Feed both want.
 * Per-ticker news (Stock Detail, commentary's per-symbol drawer) is served by
 * GET /live/news?ticker=X (src/live/ondemand.controller.ts) instead.
 */
@Controller("market-data")
export class NewsController {
  private cache: { data: Record<string, unknown>[]; at: number } | null = null;

  constructor(private readonly job: NewsJob) {}

  @Get("news")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=120, stale-while-revalidate=300",
  )
  async news(): Promise<Record<string, unknown>[]> {
    if (this.cache && Date.now() - this.cache.at < NEWS_FEED_CACHE_MS)
      return this.cache.data;

    const data = await this.job.fetchGlobalRecentLive(NEWS_FEED_LIMIT);
    this.cache = { data, at: Date.now() };
    return data;
  }
}
