import { Logger } from "@nestjs/common";
import {
  AllSourcesFailedError,
  isRetryableVendorError,
  SourceAttempt,
} from "./adapter-error";
import {
  AdapterResult,
  AdapterWarning,
  CanonicalCompany,
  CompanyProfileAdapter,
} from "./types";

export class CompositeCompanyProfileAdapter implements CompanyProfileAdapter {
  private readonly logger = new Logger(CompositeCompanyProfileAdapter.name);
  readonly sourceName: string;

  constructor(
    private readonly primary: CompanyProfileAdapter,
    private readonly secondary: CompanyProfileAdapter | null,
  ) {
    this.sourceName = secondary
      ? `${primary.sourceName}(fallback:${secondary.sourceName})`
      : primary.sourceName;
  }

  async fetchCompany(
    ticker: string,
  ): Promise<AdapterResult<CanonicalCompany> | null> {
    const attempts: SourceAttempt[] = [];
    try {
      const result = await this.primary.fetchCompany(ticker);
      if (result) return result;
      attempts.push({
        source: this.primary.sourceName,
        error: "no data returned (ticker not found on this source)",
        retryable: false,
      });
    } catch (err) {
      const message = err.message;
      const retryable = isRetryableVendorError(err);
      attempts.push({
        source: this.primary.sourceName,
        error: message,
        retryable,
      });
      this.logger.warn(
        `${this.primary.sourceName} failed for ${ticker} (${retryable ? "retryable" : "not retryable"}): ${message}` +
          (this.secondary
            ? ` — falling back to ${this.secondary.sourceName}`
            : " — no fallback configured"),
      );
    }
    if (!this.secondary) {
      throw new AllSourcesFailedError(`company ${ticker}`, attempts);
    }
    let fallbackResult: AdapterResult<CanonicalCompany> | null = null;
    try {
      fallbackResult = await this.secondary.fetchCompany(ticker);
      if (!fallbackResult) {
        attempts.push({
          source: this.secondary.sourceName,
          error: "no data returned (ticker not found on this source)",
          retryable: false,
        });
      }
    } catch (err) {
      const message = err.message;
      attempts.push({
        source: this.secondary.sourceName,
        error: message,
        retryable: isRetryableVendorError(err),
      });
    }
    if (!fallbackResult) {
      throw new AllSourcesFailedError(`company ${ticker}`, attempts);
    }
    const fallbackWarning: AdapterWarning = {
      code: "FALLBACK_USED",
      message: `Primary source ${this.primary.sourceName} failed (${attempts[0].error}) — served by fallback ${this.secondary.sourceName} instead.`,
    };
    return {
      ...fallbackResult,
      warnings: [fallbackWarning, ...fallbackResult.warnings],
    };
  }
}
