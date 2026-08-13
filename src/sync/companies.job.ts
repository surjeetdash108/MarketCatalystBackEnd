import { Inject, Injectable, Logger } from "@nestjs/common";
import { AllSourcesFailedError } from "../adapters/adapter-error";
import {
  COMPANY_PROFILE_ADAPTER,
  type CompanyProfileAdapter,
} from "../adapters/types";
import { TICKER_UNIVERSE } from "../common/ticker-universe";

@Injectable()
export class CompaniesJob {
  private readonly logger = new Logger(CompaniesJob.name);

  constructor(
    @Inject(COMPANY_PROFILE_ADAPTER)
    private readonly companyProfile: CompanyProfileAdapter,
  ) {}

  /**
   * Live-direct: sweep the reference ticker universe fetching each company
   * profile per request WITHOUT reading or writing Firestore, returning the
   * exact `{id: ticker, ...profile}` shape the `companies` collection read used
   * to yield. Backs GET /market-data/companies. This is a heavy per-ticker sweep
   * (accepted as slow live).
   *
   * DEGRADED vs. the cache era: the universe is the static TICKER_UNIVERSE
   * reference list rather than the dynamic `companies` collection (which was
   * grown by usage and is no longer written). The Firestore-backed dynamic
   * universe read was removed to keep the request path Firestore-free.
   */
  async fetchLive(): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const symbol of TICKER_UNIVERSE) {
      try {
        const result = await this.companyProfile.fetchCompany(symbol);
        if (!result) continue;
        const { data, source, warnings } = result;
        out.push({
          id: symbol,
          ...data,
          source,
          warnings,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        if (err instanceof AllSourcesFailedError) {
          this.logger.error(
            `${symbol}: every configured source failed — ${err.attempts
              .map((a) => `${a.source}: ${a.error}`)
              .join(" | ")}`,
          );
        } else {
          this.logger.error(
            `Failed live company fetch ${symbol}: ${(err as Error).message}`,
          );
        }
      }
    }
    return out;
  }
}
