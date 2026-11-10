import { Injectable } from "@nestjs/common";
import {
  PolygonService,
  type PolygonNewsArticle,
} from "../vendors/polygon/polygon.service";
import { AdapterResult, CanonicalNewsArticle, NewsAdapter } from "./types";

@Injectable()
export class PolygonNewsAdapter implements NewsAdapter {
  readonly sourceName = "polygon";

  constructor(private readonly polygon: PolygonService) {}

  /**
   * Map one raw Polygon article to the canonical shape, scoping sentiment to
   * `ticker` (Polygon carries a per-ticker insight). Shared by the per-ticker
   * `fetchNews` and the market-wide `fetchMarketNews` so both render identically.
   */
  private toCanonical(
    a: PolygonNewsArticle,
    ticker: string,
  ): CanonicalNewsArticle {
    const insight = a.insights?.find((i) => i.ticker === ticker) ?? null;
    return {
      id: a.id,
      ticker,
      headline: a.title,
      summary: a.description ?? null,
      source: a.publisher?.name ?? "Polygon",
      vendor: "polygon",
      url: a.article_url,
      category: null,
      sentiment: insight?.sentiment ?? null,
      sentimentReasoning: insight?.sentiment_reasoning ?? null,
      keywords: a.keywords ?? [],
      publishedAt: a.published_utc,
      imageUrl: a.image_url ?? null,
    };
  }

  async fetchNews(
    ticker: string,
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    const articles = await this.polygon.getNews(ticker, from, to);
    const data = articles.map((a) => this.toCanonical(a, ticker));
    return { data, source: this.sourceName, warnings: [] };
  }

  /**
   * MARKET-WIDE newest news (no ticker filter). Each article is scoped to its
   * PRIMARY ticker (`tickers[0]`, the story's subject) so it lands in the feed
   * like any per-ticker article. Articles with no ticker are skipped — the feed
   * is ticker-oriented and a tickerless row would break consumers that require it.
   */
  async fetchMarketNews(
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    const articles = await this.polygon.getMarketNews(from, to);
    const data: CanonicalNewsArticle[] = [];
    for (const a of articles) {
      // Emit one entry per MENTIONED ticker, not just `tickers[0]`. A story that
      // names NVDA, GOOG and MSFT is relevant to all three, and the bulk sweep
      // relies on this to reach the whole universe from one call — taking only
      // the first ticker silently dropped the rest. Downstream keys docs by
      // `${ticker}_${articleId}`, so this is exactly what the old per-ticker
      // fetch produced, and duplicates collapse on that id.
      for (const t of a.tickers ?? []) {
        if (t) data.push(this.toCanonical(a, t));
      }
    }
    return { data, source: this.sourceName, warnings: [] };
  }
}
