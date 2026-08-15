import { Injectable } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { AdapterResult, CanonicalNewsArticle, NewsAdapter } from "./types";

@Injectable()
export class PolygonNewsAdapter implements NewsAdapter {
  readonly sourceName = "polygon";

  constructor(private readonly polygon: PolygonService) {}

  async fetchNews(
    ticker: string,
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    const articles = await this.polygon.getNews(ticker, from, to);
    const data: CanonicalNewsArticle[] = articles.map((a) => {
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
    });
    return { data, source: this.sourceName, warnings: [] };
  }
}
