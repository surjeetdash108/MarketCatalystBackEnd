import { Injectable, Logger } from '@nestjs/common';
import { sectorFromSic } from '../common/sic-sector.util';
import { PolygonService } from '../vendors/polygon/polygon.service';
import {
  AdapterResult,
  AdapterWarning,
  CanonicalCompany,
  CompanyProfileAdapter,
} from './types';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class PolygonCompanyProfileAdapter implements CompanyProfileAdapter {
  readonly sourceName = 'polygon';
  private readonly logger = new Logger(PolygonCompanyProfileAdapter.name);

  constructor(private readonly polygon: PolygonService) {}

  async fetchCompany(
    ticker: string,
  ): Promise<AdapterResult<CanonicalCompany> | null> {
    const details = await this.polygon.getTickerDetails(ticker);
    if (!details) return null;
    const warnings: AdapterWarning[] = [
      {
        code: 'FIELD_NOT_SUPPORTED',
        field: 'dividendYield,dividendPerShare,peers',
        message:
          'Polygon has no dividend-yield or peer-list product — these fields are structurally null on this source, not a transient failure. (eps/peRatio ARE populated below from /vX/reference/financials.)',
      },
    ];
    let price = null;
    let pctChange = null;
    try {
      const to = new Date();
      const from = new Date(to);
      from.setUTCDate(from.getUTCDate() - 7);
      const bars = await this.polygon.getAggsRange(ticker, isoDate(from), isoDate(to));
      if (bars.length >= 2) {
        const last = bars[bars.length - 1];
        const prev = bars[bars.length - 2];
        price = last.c;
        pctChange =
          prev.c > 0
            ? Math.round(((last.c - prev.c) / prev.c) * 10000) / 100
            : null;
      } else if (bars.length === 1) {
        price = bars[0].c;
        warnings.push({
          code: 'SUB_REQUEST_FAILED',
          field: 'pctChange',
          message:
            'Only one trading day of bars returned in the lookback window — cannot compute pctChange.',
        });
      } else {
        warnings.push({
          code: 'SUB_REQUEST_FAILED',
          field: 'price,pctChange',
          message: 'No recent bars returned for this ticker in the last 7 days.',
        });
      }
    } catch (err) {
      const reason = err.message;
      this.logger.warn(`Failed fetching recent bars for ${ticker}: ${reason}`);
      warnings.push({
        code: 'SUB_REQUEST_FAILED',
        field: 'price,pctChange',
        message: `Recent-bars request failed: ${reason}`,
      });
    }
    let eps = null;
    let peRatio = null;
    try {
      eps = await this.polygon.getTtmEps(ticker);
      if (eps != null && price != null && eps > 0) {
        peRatio = Math.round((price / eps) * 100) / 100;
      }
    } catch (err) {
      const reason = err.message;
      this.logger.warn(`Failed fetching TTM EPS for ${ticker}: ${reason}`);
      warnings.push({
        code: 'SUB_REQUEST_FAILED',
        field: 'eps,peRatio',
        message: `TTM financials request failed: ${reason}`,
      });
    }
    const data: CanonicalCompany = {
      ticker,
      name: details.name ?? null,
      price,
      pctChange,
      marketCap: details.market_cap ?? null,
      beta: null,
      // sic_description is an INDUSTRY ("ELECTRONIC COMPUTERS"), not a sector.
      // Writing it to both fields put SIC descriptions in companies.sector,
      // which tech-rating groups by to compute sectorRank — so ranks were
      // computed within an SIC code rather than a sector, and the field could
      // never be joined against the `sectors` collection. Derive the sector
      // from sic_code instead; null when unmappable, never a guess.
      sector: sectorFromSic(details.sic_code),
      industry: details.sic_description ?? null,
      exchange: details.primary_exchange ?? null,
      week52Range: null,
      volume: null,
      averageVolume: null,
      description: details.description ?? null,
      peRatio,
      eps,
      dividendYield: null,
      dividendPerShare: null,
      peers: [],
    };
    return { data, source: this.sourceName, warnings };
  }
}
