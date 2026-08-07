import { Logger } from '@nestjs/common';
import {
  AllSourcesFailedError,
  isRetryableVendorError,
  SourceAttempt,
} from './adapter-error';
import { PolygonService } from '../vendors/polygon/polygon.service';
import type { AdapterResult, CanonicalQuote, QuoteAdapter } from './types';

export class PolygonQuoteAdapter implements QuoteAdapter {
  readonly sourceName = 'polygon';
  constructor(private readonly polygon: PolygonService) {}

  async fetchQuote(
    ticker: string,
  ): Promise<AdapterResult<CanonicalQuote> | null> {
    const quote = await this.polygon.getDailyQuote(ticker);
    if (!quote) return null;
    return { data: quote, source: this.sourceName, warnings: [] };
  }
}

/**
 * Quotes need a bespoke composite rather than withFallback(): this interface is
 * nullable, and "the vendor has no quote for this symbol" must stay distinct
 * from "the vendor call failed". A null primary falls through to the secondary;
 * both null returns null, and the caller decides whether that is fatal.
 */
export class CompositeQuoteAdapter implements QuoteAdapter {
  private readonly logger = new Logger(CompositeQuoteAdapter.name);
  readonly sourceName: string;

  constructor(
    private readonly primary: QuoteAdapter,
    private readonly secondary: QuoteAdapter | null,
  ) {
    this.sourceName = secondary
      ? `${primary.sourceName}(fallback:${secondary.sourceName})`
      : primary.sourceName;
  }

  async fetchQuote(
    ticker: string,
  ): Promise<AdapterResult<CanonicalQuote> | null> {
    const attempts: SourceAttempt[] = [];
    let primaryEmpty = false;

    try {
      const res = await this.primary.fetchQuote(ticker);
      if (res) return res;
      primaryEmpty = true;
    } catch (err) {
      attempts.push({
        source: this.primary.sourceName,
        error: (err as Error).message,
        retryable: isRetryableVendorError(err),
      });
      this.logger.warn(
        `${this.primary.sourceName} quote for ${ticker} failed: ${(err as Error).message}`,
      );
    }

    if (!this.secondary) {
      if (primaryEmpty) return null;
      throw new AllSourcesFailedError(`quote for ${ticker}`, attempts);
    }

    try {
      const res = await this.secondary.fetchQuote(ticker);
      if (!res) return null;
      return {
        ...res,
        warnings: [
          ...res.warnings,
          {
            code: 'FALLBACK_USED',
            message: primaryEmpty
              ? `${this.primary.sourceName} had no quote for ${ticker} — served by ${this.secondary.sourceName}.`
              : `${this.primary.sourceName} failed (${attempts[0].error}) — served by ${this.secondary.sourceName}.`,
          },
        ],
      };
    } catch (err) {
      attempts.push({
        source: this.secondary.sourceName,
        error: (err as Error).message,
        retryable: isRetryableVendorError(err),
      });
      // Primary merely had no data and the fallback errored — still no quote,
      // not a hard failure, so the caller can skip this symbol.
      if (primaryEmpty) return null;
      throw new AllSourcesFailedError(`quote for ${ticker}`, attempts);
    }
  }
}
