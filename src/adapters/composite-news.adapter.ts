import { Logger } from "@nestjs/common";
import {
  AllSourcesFailedError,
  isRetryableVendorError,
  SourceAttempt,
} from "./adapter-error";
import {
  AdapterResult,
  AdapterWarning,
  CanonicalNewsArticle,
  NewsAdapter,
} from "./types";

export class CompositeNewsAdapter implements NewsAdapter {
  private readonly logger = new Logger(CompositeNewsAdapter.name);
  readonly sourceName: string;

  constructor(
    private readonly primary: NewsAdapter,
    private readonly secondary: NewsAdapter | null,
  ) {
    this.sourceName = secondary
      ? `${primary.sourceName}(fallback:${secondary.sourceName})`
      : primary.sourceName;
  }

  /**
   * Market-wide newest news, proxied to the PRIMARY source only (the head-fetch
   * is a Polygon capability; there is no per-story fallback semantics here). When
   * the primary has no market-wide endpoint this degrades to an empty result, so
   * the caller's feed simply omits the head-fetch instead of erroring.
   */
  async fetchMarketNews(
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    if (!this.primary.fetchMarketNews) {
      return { data: [], source: this.sourceName, warnings: [] };
    }
    return this.primary.fetchMarketNews(from, to);
  }

  async fetchNews(
    ticker: string,
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    const attempts: SourceAttempt[] = [];
    try {
      return await this.primary.fetchNews(ticker, from, to);
    } catch (err) {
      const message = err.message;
      const retryable = isRetryableVendorError(err);
      attempts.push({
        source: this.primary.sourceName,
        error: message,
        retryable,
      });
      this.logger.warn(
        `${this.primary.sourceName} news fetch failed for ${ticker} (${retryable ? "retryable" : "not retryable"}): ${message}` +
          (this.secondary
            ? ` — falling back to ${this.secondary.sourceName}`
            : " — no fallback configured"),
      );
    }
    if (!this.secondary) {
      throw new AllSourcesFailedError(`news ${ticker}`, attempts);
    }
    try {
      const fallbackResult = await this.secondary.fetchNews(ticker, from, to);
      const fallbackWarning: AdapterWarning = {
        code: "FALLBACK_USED",
        message: `Primary news source ${this.primary.sourceName} failed (${attempts[0].error}) — served by fallback ${this.secondary.sourceName} instead.`,
      };
      return {
        ...fallbackResult,
        warnings: [fallbackWarning, ...fallbackResult.warnings],
      };
    } catch (err) {
      attempts.push({
        source: this.secondary.sourceName,
        error: err.message,
        retryable: isRetryableVendorError(err),
      });
      throw new AllSourcesFailedError(`news ${ticker}`, attempts);
    }
  }
}
