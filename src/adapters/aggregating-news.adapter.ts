import { Logger } from '@nestjs/common';
import { AllSourcesFailedError, isRetryableVendorError, SourceAttempt } from './adapter-error';
import {
  AdapterResult,
  AdapterWarning,
  CanonicalNewsArticle,
  NewsAdapter,
} from './types';

export class AggregatingNewsAdapter implements NewsAdapter {
  private readonly logger = new Logger(AggregatingNewsAdapter.name);
  readonly sourceName: string;

  constructor(private readonly sources: NewsAdapter[]) {
    this.sourceName = `aggregate(${sources.map((s) => s.sourceName).join('+')})`;
  }

  async fetchNews(
    ticker: string,
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    const settled = await Promise.allSettled(
      this.sources.map((s) => s.fetchNews(ticker, from, to)),
    );
    const merged: CanonicalNewsArticle[] = [];
    const warnings: AdapterWarning[] = [];
    const attempts: SourceAttempt[] = [];
    let anySucceeded = false;
    settled.forEach((res, i) => {
      const src = this.sources[i].sourceName;
      if (res.status === 'fulfilled') {
        anySucceeded = true;
        merged.push(...res.value.data);
        warnings.push(...res.value.warnings);
      } else {
        const message = res.reason.message;
        attempts.push({
          source: src,
          error: message,
          retryable: isRetryableVendorError(res.reason),
        });
        warnings.push({
          code: 'SUB_REQUEST_FAILED',
          message: `News source ${src} failed for ${ticker}: ${message}`,
        });
        this.logger.warn(`${src} news fetch failed for ${ticker}: ${message}`);
      }
    });
    if (!anySucceeded) {
      throw new AllSourcesFailedError(`news ${ticker}`, attempts);
    }
    const seen = new Set<string>();
    const deduped: CanonicalNewsArticle[] = [];
    for (const a of merged) {
      const urlKey = (a.url || '').trim().toLowerCase();
      const titleKey =
        'h:' +
        a.headline
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
      if ((urlKey && seen.has(urlKey)) || seen.has(titleKey)) continue;
      if (urlKey) seen.add(urlKey);
      seen.add(titleKey);
      deduped.push(a);
    }
    deduped.sort((x, y) => y.publishedAt.localeCompare(x.publishedAt));
    return { data: deduped, source: this.sourceName, warnings };
  }
}
