import { Logger } from '@nestjs/common';
import { AllSourcesFailedError, isRetryableVendorError, SourceAttempt } from './adapter-error';
import {
  AdapterResult,
  AdapterWarning,
  CanonicalMoverBase,
  MoversAdapter,
} from './types';

export class CompositeMoversAdapter implements MoversAdapter {
  private readonly logger = new Logger(CompositeMoversAdapter.name);
  readonly sourceName: string;

  constructor(
    private readonly primary: MoversAdapter,
    private readonly secondary: MoversAdapter | null,
  ) {
    this.sourceName = secondary
      ? `${primary.sourceName}(fallback:${secondary.sourceName})`
      : primary.sourceName;
  }

  async fetchTopMovers(topN: number): Promise<
    AdapterResult<{
      date: string;
      gainers: CanonicalMoverBase[];
      losers: CanonicalMoverBase[];
    }>
  > {
    const attempts: SourceAttempt[] = [];
    try {
      return await this.primary.fetchTopMovers(topN);
    } catch (err) {
      const message = err.message;
      const retryable = isRetryableVendorError(err);
      attempts.push({
        source: this.primary.sourceName,
        error: message,
        retryable,
      });
      this.logger.warn(
        `${this.primary.sourceName} movers fetch failed (${retryable ? 'retryable' : 'not retryable'}): ${message}` +
          (this.secondary
            ? ` — falling back to ${this.secondary.sourceName}`
            : ' — no fallback configured'),
      );
    }
    if (!this.secondary) {
      throw new AllSourcesFailedError('market movers', attempts);
    }
    try {
      const fallbackResult = await this.secondary.fetchTopMovers(topN);
      const fallbackWarning: AdapterWarning = {
        code: 'FALLBACK_USED',
        message: `Primary source ${this.primary.sourceName} failed (${attempts[0].error}) — served by fallback ${this.secondary.sourceName} instead.`,
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
      throw new AllSourcesFailedError('market movers', attempts);
    }
  }
}
