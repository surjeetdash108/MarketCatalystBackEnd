import { Injectable } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the global-news slice of the `news` sync job + its
 * in-controller cache. The old job crawled news per-ticker across the whole
 * universe into the `news` collection; the global feed then read the 60 most
 * recent. Now served in ONE Polygon call: `getMarketNews` hits reference/news
 * WITHOUT a ticker filter, i.e. the most recent articles market-wide — exactly
 * the "most recent across every ticker" feed the Dashboard/commentary/recap Live
 * views want. Mapped to the `NewsArticleDoc` shape (same fields news.job wrote).
 *
 * Per-ticker news (Stock detail, per-symbol drawer) is unaffected — it's served
 * by GET /live/news?ticker=X in the on-demand layer.
 *
 * 60s reuse window: a market news feed turns over in minutes, and this keeps the
 * Dashboard + commentary + recap Live views from each firing their own Polygon
 * call. Still an in-memory coalesce, no cache/cron.
 */
const FEED_LIMIT = 60;
const REUSE_MS = 60_000;

@Injectable()
export class LiveNewsService {
  private readonly coalescer = new LiveCoalescer(REUSE_MS);

  constructor(private readonly polygon: PolygonService) {}

  async getNews() {
    return this.coalescer.run("market-news", async () => {
      const articles = await this.polygon.getMarketNews(FEED_LIMIT);
      const now = new Date().toISOString();
      return articles.map((a) => {
        // The feed's primary ticker: first of the article's tickers[]. Insight
        // sentiment (when Polygon provides it) is keyed by ticker, so match it.
        const ticker = a.tickers?.[0] ?? "";
        const insight =
          a.insights?.find((i) => i.ticker === ticker) ?? a.insights?.[0] ?? null;
        return {
          id: a.id,
          ticker,
          headline: a.title,
          summary: a.description ?? null,
          source: a.publisher?.name ?? "Polygon",
          url: a.article_url,
          category: null as string | null,
          sentiment: insight?.sentiment ?? null,
          sentimentReasoning: insight?.sentiment_reasoning ?? null,
          keywords: a.keywords ?? [],
          imageUrl: a.image_url ?? null,
          publishedAt: a.published_utc,
          updatedAt: now,
        };
      });
    });
  }
}
