export type ETFCategory =
  | "largest"
  | "equity"
  | "bitcoin"
  | "ethereum"
  | "gold"
  | "fixedIncome"
  | "realEstate"
  | "totalMarket"
  | "commodities"
  | "leveraged";

export interface NormalizedETF {
  symbol: string;
  name: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  aum: number | null;
  expenseRatio?: number | null;
  assetClass?: string;
  focus?: string;
  category?: string;
  description?: string;
  underlyingAsset?: string;
  underlyingIndex?: string;
  leverage?: number | null;
  isLeveraged?: boolean;
  provider?: string;
  lastUpdated?: string;
  badge?: string;
  categories: ETFCategory[];
}

export interface EtfCategorySection {
  id: string;
  label: string;
  funds: NormalizedETF[];
}

export interface EtfMarketResponse {
  updatedAt: number;
  source: string;
  categories: EtfCategorySection[];
  largest: NormalizedETF[];
  equity: NormalizedETF[];
  bitcoin: NormalizedETF[];
  ethereum: NormalizedETF[];
  gold: NormalizedETF[];
  fixedIncome: NormalizedETF[];
  "fixed-income"?: NormalizedETF[];
  "fixed_income"?: NormalizedETF[];
  realEstate: NormalizedETF[];
  "real-estate"?: NormalizedETF[];
  "real_estate"?: NormalizedETF[];
  totalMarket: NormalizedETF[];
  "total-market"?: NormalizedETF[];
  "total_market"?: NormalizedETF[];
  commodities: NormalizedETF[];
  leveraged: NormalizedETF[];
}
