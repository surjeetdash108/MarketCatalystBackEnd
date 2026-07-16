import { Injectable, Logger } from '@nestjs/common';
import { FmpService } from '../vendors/fmp/fmp.service';
import {
  AdapterResult,
  AdapterWarning,
  CanonicalCompany,
  CompanyProfileAdapter,
} from './types';

@Injectable()
export class FmpCompanyProfileAdapter implements CompanyProfileAdapter {
  readonly sourceName = 'fmp';
  private readonly logger = new Logger(FmpCompanyProfileAdapter.name);

  constructor(private readonly fmp: FmpService) {}

  async fetchCompany(
    ticker: string,
  ): Promise<AdapterResult<CanonicalCompany> | null> {
    const [profileResult, ratiosResult, peersResult] = await Promise.allSettled([
      this.fmp.getProfile(ticker),
      this.fmp.getRatiosTtm(ticker),
      this.fmp.getPeers(ticker),
    ]);
    if (profileResult.status === 'rejected') {
      const reason = profileResult.reason;
      throw new Error(
        `FMP profile request failed for ${ticker}: ${reason.message ?? reason}`,
      );
    }
    const profile = profileResult.value;
    if (!profile) return null;
    const warnings: AdapterWarning[] = [];
    if (ratiosResult.status === 'rejected') {
      const reason = ratiosResult.reason?.message ?? String(ratiosResult.reason);
      this.logger.warn(
        `ratios-ttm unavailable for ${ticker} (plan restriction): ${reason}`,
      );
      warnings.push({
        code: 'SUB_REQUEST_FAILED',
        field: 'peRatio,eps,dividendYield,dividendPerShare',
        message: `FMP ratios-ttm request failed for ${ticker} (${reason}) — likely this plan's undocumented per-symbol restriction, not a genuine absence of data.`,
      });
    }
    if (peersResult.status === 'rejected') {
      const reason = peersResult.reason?.message ?? String(peersResult.reason);
      this.logger.warn(`stock-peers unavailable for ${ticker}: ${reason}`);
      warnings.push({
        code: 'SUB_REQUEST_FAILED',
        field: 'peers',
        message: `FMP stock-peers request failed for ${ticker} (${reason}).`,
      });
    }
    const ratios = ratiosResult.status === 'fulfilled' ? ratiosResult.value : null;
    const peers = peersResult.status === 'fulfilled' ? peersResult.value : [];
    const data: CanonicalCompany = {
      ticker,
      name: profile.companyName ?? null,
      price: profile.price ?? null,
      pctChange: profile.changePercentage ?? null,
      marketCap: profile.marketCap ?? null,
      beta: profile.beta ?? null,
      sector: profile.sector ?? null,
      industry: profile.industry ?? null,
      exchange: profile.exchange ?? null,
      week52Range: profile.range ?? null,
      volume: profile.volume ?? null,
      averageVolume: profile.averageVolume ?? null,
      description: profile.description ?? null,
      peRatio: ratios?.priceToEarningsRatioTTM ?? null,
      eps: ratios?.netIncomePerShareTTM ?? null,
      dividendYield: ratios?.dividendYieldTTM ?? null,
      dividendPerShare: ratios?.dividendPerShareTTM ?? null,
      peers: peers.map((p) => p.symbol),
    };
    return { data, source: this.sourceName, warnings };
  }
}
