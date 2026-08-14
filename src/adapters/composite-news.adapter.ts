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
