export interface CanonicalCompany {
  ticker: string;
  name: string | null;
  price: number | null;
  pctChange: number | null;
  marketCap: number | null;
  beta: number | null;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  week52Range: string | null;
  volume: number | null;
  averageVolume: number | null;
  description: string | null;
  peRatio: number | null;
  eps: number | null;
  dividendYield: number | null;
  dividendPerShare: number | null;
  peers: string[];
}

export interface CanonicalMoverBase {
  ticker: string;
  price: number;
  pctChange: number;
  volume: number;
  asOfDate: string;
}

export type CapBucket = 'Mega' | 'Large' | 'Mid' | 'Small' | 'Micro';

export interface MoverEnrichment {
  name: string | null;
  sector: string | null;
  cap: CapBucket | null;
}

export interface CanonicalNewsArticle {
  id: string;
  ticker: string;
  headline: string;
  summary: string | null;
  source: string;
  url: string;
  category: string | null;
  sentiment: 'positive' | 'negative' | 'neutral' | null;
  sentimentReasoning: string | null;
  keywords: string[];
  publishedAt: string;
}

export interface AdapterWarning {
  code: 'SUB_REQUEST_FAILED' | 'FIELD_NOT_SUPPORTED' | 'FALLBACK_USED' | 'STALE_DATA';
  message: string;
  field?: string;
}

export interface AdapterResult<T> {
  data: T;
  source: string;
  warnings: AdapterWarning[];
}

export interface CompanyProfileAdapter {
  readonly sourceName: string;
  fetchCompany(ticker: string): Promise<AdapterResult<CanonicalCompany> | null>;
}

export interface MoversAdapter {
  readonly sourceName: string;
  fetchTopMovers(topN: number): Promise<
    AdapterResult<{
      date: string;
      gainers: CanonicalMoverBase[];
      losers: CanonicalMoverBase[];
    }>
  >;
}

export interface MoverEnrichmentAdapter {
  readonly sourceName: string;
  enrichTicker(ticker: string): Promise<AdapterResult<MoverEnrichment> | null>;
}

export interface NewsAdapter {
  readonly sourceName: string;
  fetchNews(
    ticker: string,
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>>;
}

export const COMPANY_PROFILE_ADAPTER: unique symbol = Symbol('COMPANY_PROFILE_ADAPTER');
export const MOVERS_ADAPTER: unique symbol = Symbol('MOVERS_ADAPTER');
export const MOVER_ENRICHMENT_ADAPTER: unique symbol = Symbol('MOVER_ENRICHMENT_ADAPTER');
export const NEWS_ADAPTER: unique symbol = Symbol('NEWS_ADAPTER');

export function capBucket(marketCap: number | null): CapBucket | null {
  if (marketCap == null) return null;
  if (marketCap >= 200e9) return 'Mega';
  if (marketCap >= 10e9) return 'Large';
  if (marketCap >= 2e9) return 'Mid';
  if (marketCap >= 300e6) return 'Small';
  return 'Micro';
}
