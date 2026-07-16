import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AllSourcesFailedError } from '../adapters/adapter-error';
import { NEWS_ADAPTER, type NewsAdapter } from '../adapters/types';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { chunkedBatchSet } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { TICKER_UNIVERSE } from '../common/ticker-universe';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'news';
const BATCH_SIZE = 80;
const LOOKBACK_DAYS = 2;
const DELAY_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class NewsJob implements OnModuleInit {
  private readonly logger = new Logger(NewsJob.name);

  constructor(
    @Inject(NEWS_ADAPTER) private readonly news: NewsAdapter,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['news'],
      cronExpression: '*/30 9-16 * * 1-5',
      timeZone: 'America/New_York',
    });
  }

  @Cron('*/30 9-16 * * 1-5', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from({ length: BATCH_SIZE }, (_, i) => TICKER_UNIVERSE[(cursor + i) % TICKER_UNIVERSE.length]);
      const to = new Date();
      const from = new Date();
      from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
      const docs = [];
      let fallbackCount = 0;
      for (const symbol of batch) {
        try {
          const result = await this.news.fetchNews(symbol, isoDate(from), isoDate(to));
          if (result.warnings.some((w) => w.code === 'FALLBACK_USED')) {
            fallbackCount++;
          }
          for (const a of result.data.slice(0, 5)) {
            docs.push({
              id: `${symbol}_${a.id}`,
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
                publishedAt: a.publishedAt,
                updatedAt: new Date().toISOString(),
              },
            });
          }
        } catch (err) {
          if (err instanceof AllSourcesFailedError) {
            this.logger.error(`${symbol}: every configured news source failed — ${err.attempts.map((a) => `${a.source}: ${a.error}`).join(' | ')}`);
          } else {
            this.logger.error(`Failed fetching news for ${symbol}: ${err.message}`);
          }
        }
        await sleep(DELAY_MS);
      }
      await chunkedBatchSet(this.firebase.firestore, 'news', docs);
      await this.meta.setCursor(JOB_NAME, (cursor + BATCH_SIZE) % TICKER_UNIVERSE.length);
      await this.meta.record(JOB_NAME, {
        ok: true,
        count: docs.length,
        ...(fallbackCount > 0
          ? {
            error: `${fallbackCount}/${batch.length} tickers served by fallback news source`,
          }
          : {}),
      });
      return { count: docs.length, fallbackCount };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
