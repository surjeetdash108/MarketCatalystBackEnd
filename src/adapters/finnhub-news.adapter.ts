import { Injectable } from '@nestjs/common';
import { FinnhubService } from '../vendors/finnhub/finnhub.service';
import {
  AdapterResult,
  AdapterWarning,
  CanonicalNewsArticle,
  NewsAdapter,
} from './types';

@Injectable()
export class FinnhubNewsAdapter implements NewsAdapter {
  readonly sourceName = 'finnhub';

  constructor(private readonly finnhub: FinnhubService) {}

  async fetchNews(
    ticker: string,
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    const articles = await this.finnhub.getCompanyNews(ticker, from, to);
    const data: CanonicalNewsArticle[] = articles.map((a) => ({
      id: String(a.id),
      ticker,
      headline: a.headline,
      summary: a.summary,
      source: a.source,
      url: a.url,
      category: a.category,
      sentiment: null,
      sentimentReasoning: null,
      keywords: [],
      publishedAt: new Date(a.datetime * 1000).toISOString(),
      imageUrl: (a as { image?: string }).image || null,
    }));
    const warnings: AdapterWarning[] =
      data.length > 0
        ? [
            {
              code: 'FIELD_NOT_SUPPORTED',
              field: 'sentiment,sentimentReasoning,keywords',
              message:
                'Finnhub /company-news has no sentiment/keyword fields — structurally null on this source, not a transient failure.',
            },
          ]
        : [];
    return { data, source: this.sourceName, warnings };
  }
}
