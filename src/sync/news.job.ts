import { Inject, Injectable, Logger } from "@nestjs/common";
import { NEWS_ADAPTER, type NewsAdapter } from "../adapters/types";
import { TICKER_UNIVERSE } from "../common/ticker-universe";

const LOOKBACK_DAYS = 2;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class NewsJob {
  private readonly logger = new Logger(NewsJob.name);

  constructor(
    @Inject(NEWS_ADAPTER) private readonly news: NewsAdapter,
  ) {}

  /**
   * Live-direct: the global "most recent across every ticker" feed, fetched
   * fresh from the news vendor per request WITHOUT writing Firestore, shaped
   * into the same `{id, ...data}` docs the `news` collection read yielded and
   * returned newest-first, capped at `limit`. Backs GET /market-data/news.
   *
   * Sweeps the FULL ticker universe (the collection this replaces accumulated
   * across many cursor runs), so it is a heavy per-ticker vendor sweep —
   * accepted as slow for a live read that must approximate the whole feed.
   */
  async fetchGlobalRecentLive(limit: number): Promise<Record<string, unknown>[]> {
    const to = new Date();
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
    const docs: { id: string; publishedAt: unknown; data: Record<string, unknown> }[] =
      [];
    for (const symbol of TICKER_UNIVERSE) {
      try {
        const result = await this.news.fetchNews(
          symbol,
          isoDate(from),
          isoDate(to),
        );
        for (const a of result.data.slice(0, 5)) {
          docs.push({
            id: `${symbol}_${a.id}`,
            publishedAt: a.publishedAt,
            data: {
              ticker: a.ticker,
              headline: a.headline,
              summary: a.summary,
              source: a.source,
              url: a.url,
              category: a.category,
              sentiment: a.sentiment,
              sentimentReasoning: a.sentimentReasoning,
              keywords: a.keywords,
              imageUrl: a.imageUrl,
              publishedAt: a.publishedAt,
              updatedAt: new Date().toISOString(),
            },
          });
        }
      } catch (err) {
        this.logger.error(
          `Failed live news fetch for ${symbol}: ${(err as Error).message}`,
        );
      }
    }
    docs.sort((a, b) =>
      String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")),
    );
    return docs.slice(0, limit).map((d) => ({ id: d.id, ...d.data }));
  }
}
