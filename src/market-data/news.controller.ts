import { Controller, Get, Header, Inject, Logger } from '@nestjs/common';
import { AllSourcesFailedError } from '../adapters/adapter-error';
import { NEWS_ADAPTER, type NewsAdapter } from '../adapters/types';
import { TICKER_UNIVERSE } from '../common/ticker-universe';

const NEWS_FEED_LIMIT = 60;
const LOOKBACK_DAYS = 2;
const PER_TICKER_LIMIT = 5;
const CONCURRENCY = 25;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * GET /market-data/news — the global "most recent across every ticker" feed
 * that commentary.tsx's Live tab and Dashboard's Live Market Feed both want.
 * Calls the news adapter directly on every request (no Firestore cache, no
 * sync job, no in-memory cache) — mirrors news.job.ts's per-ticker fetch,
 * fanned out with a concurrency cap (same reasoning as companies.controller.ts:
 * the vendor isn't rate-limited on a paid key, so sequential-with-sleep is
 * unnecessary latency). Drops the job's notification-publish pass and
 * `companies.newsCount` denormalization write — both are side effects of a
 * write path, not part of what a GET should do.
 */
@Controller('market-data')
export class NewsController {
  private readonly logger = new Logger(NewsController.name);

  constructor(@Inject(NEWS_ADAPTER) private readonly newsAdapter: NewsAdapter) {}

  @Get('news')
  @Header('Cache-Control', 'no-store')
  async news(): Promise<Record<string, unknown>[]> {
    const to = new Date();
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
    const fromIso = isoDate(from);
    const toIso = isoDate(to);

    const docs: Record<string, unknown>[] = [];
    for (let i = 0; i < TICKER_UNIVERSE.length; i += CONCURRENCY) {
      const chunk = TICKER_UNIVERSE.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const result = await this.newsAdapter.fetchNews(symbol, fromIso, toIso);
            return result.data.slice(0, PER_TICKER_LIMIT).map((a) => ({
              id: `${symbol}_${a.id}`,
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
            }));
          } catch (err) {
            if (err instanceof AllSourcesFailedError) {
              this.logger.error(`${symbol}: every configured news source failed`);
            } else {
              this.logger.error(`Failed fetching news for ${symbol}: ${(err as Error).message}`);
            }
            return [];
          }
        }),
      );
      docs.push(...results.flat());
    }

    docs.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
    return docs.slice(0, NEWS_FEED_LIMIT);
  }
}
