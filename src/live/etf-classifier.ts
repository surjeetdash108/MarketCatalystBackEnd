import { Injectable, Logger } from "@nestjs/common";
import { ETFCategory, NormalizedETF } from "./etf-model";

export interface ETFClassificationInput {
  symbol: string;
  name: string;
  type?: string;
  assetClass?: string;
  focus?: string;
  category?: string;
  description?: string;
  strategy?: string;
  underlyingAsset?: string;
  underlyingIndex?: string;
  leverage?: number | null;
  sic_description?: string;
  aum?: number | null;
  volume?: number | null;
}

/**
 * Deterministic, metadata-driven ETF classification engine.
 *
 * Implements TradingView-style classification rules across the 10 existing
 * MarketCatalyst ETF Corner sections:
 *
 *   1. Largest       — Broad ETF universe sorted by AUM descending.
 *   2. Equity        — Equities, large-cap, mid-cap, small-cap, dividend, growth, value, index funds.
 *   3. Bitcoin       — Spot/futures/strategy Bitcoin exposure.
 *   4. Ethereum      — Spot/futures/strategy Ethereum/Ether exposure.
 *   5. Gold          — Physical gold, bullion, gold futures, gold miners.
 *   6. Fixed Income  — Bonds, Treasuries, corporate/muni debt, aggregate, high-yield, CLOs.
 *   7. Real Estate   — REITs, residential/commercial real estate, mortgages.
 *   8. Total Market  — Broad-market, total world, all-country, total stock market exposure.
 *   9. Commodities   — Energy, metals, agriculture, and commodity trusts (including Gold).
 *  10. Leveraged     — 2x, 3x, Ultra, Daily Bull/Bear, inverse leveraged funds.
 *
 * ETFs can naturally belong to multiple categories (e.g. GLD -> Gold + Commodities;
 * VTI -> Equity + Total Market; TQQQ -> Leveraged + Equity).
 */
@Injectable()
export class ETFClassifier {
  private readonly logger = new Logger(ETFClassifier.name);

  /**
   * Normalizes arbitrary text by lowercasing and trimming punctuation for consistent matching.
   */
  public normalizeText(text?: string | null): string {
    if (!text) return "";
    return text.toLowerCase().trim();
  }

  /**
   * Classify an ETF into its applicable ETFCategory buckets.
   */
  public classify(etf: ETFClassificationInput): ETFCategory[] {
    const categories = new Set<ETFCategory>();

    // 0. Largest: Broad ETF universe
    categories.add("largest");

    // Gather normalized metadata strings with priority
    const name = this.normalizeText(etf.name);
    const assetClass = this.normalizeText(etf.assetClass);
    const focus = this.normalizeText(etf.focus);
    const category = this.normalizeText(etf.category);
    const desc = this.normalizeText(etf.description);
    const strategy = this.normalizeText(etf.strategy);
    const underlying = this.normalizeText(
      `${etf.underlyingAsset || ""} ${etf.underlyingIndex || ""}`
    );
    const type = (etf.type || "").toUpperCase();
    const sic = this.normalizeText(etf.sic_description);

    // Composite metadata text for content scanning
    const fullMetadata = `${name} ${assetClass} ${focus} ${category} ${underlying} ${strategy} ${desc} ${sic}`;

    // ── 1. Bitcoin ──
    const isBitcoinExplicit =
      assetClass.includes("bitcoin") ||
      focus.includes("bitcoin") ||
      category.includes("bitcoin") ||
      underlying.includes("bitcoin");
    const isBitcoinContent =
      /\b(bitcoin|btc|bitcoin futures|bitcoin strategy|spot bitcoin)\b/i.test(
        fullMetadata
      );
    const isBitcoin = isBitcoinExplicit || isBitcoinContent;
    if (isBitcoin) {
      categories.add("bitcoin");
    }

    // ── 2. Ethereum ──
    const isEthExplicit =
      assetClass.includes("ethereum") ||
      focus.includes("ethereum") ||
      category.includes("ethereum") ||
      underlying.includes("ethereum") ||
      underlying.includes("ether");
    const isEthContent =
      /\b(ethereum|ether|ethereum futures|ethereum strategy|spot ether)\b/i.test(
        fullMetadata
      ) ||
      (/\beth\b/i.test(fullMetadata) &&
        /\b(etf|fund|trust|crypto|shares|token)\b/i.test(fullMetadata));
    const isEthereum = isEthExplicit || isEthContent;
    if (isEthereum) {
      categories.add("ethereum");
    }

    // ── 3. Gold ──
    // Note: \bgold\b matches only the word "gold", safely excluding "goldman sachs"
    const isGoldExplicit =
      focus.includes("gold") ||
      category.includes("gold") ||
      underlying.includes("gold");
    const isGoldContent = /\b(gold|bullion|gold bullion|gold futures|physical gold)\b/i.test(
      `${name} ${focus} ${category} ${underlying} ${desc}`
    );
    const isGold = isGoldExplicit || isGoldContent;
    if (isGold) {
      categories.add("gold");
    }

    // ── 4. Commodities ──
    // Commodities include Gold, Silver, Energy/Oil/Gas, Agriculture, Industrial Metals,
    // and statutory commodity vehicles (e.g. ETV type or SIC commodity trusts).
    const isCommodityExplicit =
      assetClass.includes("commodity") ||
      focus.includes("commodity") ||
      category.includes("commodity") ||
      type === "ETV" ||
      sic.includes("commodity");
    const isCommodityContent =
      /\b(commodit|crude oil|natural gas|silver|copper|precious metals?|agriculture|brent|wti|platinum|palladium|wheat|corn|oil fund|energy index|metals? trust)\b/i.test(
        fullMetadata
      );
    // Gold ETFs belong to both Gold and Commodities as per TradingView model
    const isCommodity =
      (isGold || isCommodityExplicit || isCommodityContent) &&
      !isBitcoin &&
      !isEthereum;
    if (isCommodity) {
      categories.add("commodities");
    }

    // ── 5. Fixed Income ──
    const isFixedIncomeExplicit =
      assetClass.includes("fixed income") ||
      assetClass.includes("bond") ||
      focus.includes("bond") ||
      category.includes("bond") ||
      category.includes("debt") ||
      underlying.includes("bond") ||
      underlying.includes("treasury");
    const isFixedIncomeContent =
      /\b(bond|bonds|treasury|treasuries|fixed[- ]income|debt|corporate bond|government bond|aggregate|clo|high yield|tips|muni|municipal|credit|inflation[- ]protected|floating rate|senior loan)\b/i.test(
        fullMetadata
      );
    const isFixedIncome =
      (isFixedIncomeExplicit || isFixedIncomeContent) &&
      !isBitcoin &&
      !isEthereum;
    if (isFixedIncome) {
      categories.add("fixedIncome");
    }

    // ── 6. Real Estate ──
    const isRealEstateExplicit =
      assetClass.includes("real estate") ||
      focus.includes("real estate") ||
      focus.includes("reit") ||
      category.includes("real estate") ||
      category.includes("reit");
    const isRealEstateContent =
      /\b(real estate|reit|reits|property|realty|mortgage)\b/i.test(
        `${name} ${focus} ${category} ${underlying} ${desc}`
      );
    const isRealEstate = isRealEstateExplicit || isRealEstateContent;
    if (isRealEstate) {
      categories.add("realEstate");
    }

    // ── 7. Leveraged ──
    // Leveraged funds use 2x, 3x, Ultra, Daily Bull/Bear to amplify exposure.
    // Critical distinction: Exclude ultra-short duration bond/treasury funds.
    const isUltraDurationBond =
      /ultra[- ]?short (?:bond|income|duration|fixed|maturity|treasury)/i.test(
        fullMetadata
      );
    const hasExplicitLeverage =
      etf.leverage != null &&
      Number.isFinite(etf.leverage) &&
      (etf.leverage > 1 || etf.leverage < -0.5);
    const hasLeveragedPatterns =
      !isUltraDurationBond &&
      /\b(ultrapro|ultra|leveraged|[23]x|daily.*(?:bull|bear)|daily target|inverse)\b/i.test(
        `${name} ${focus} ${strategy} ${category}`
      );
    const isLeveraged = hasExplicitLeverage || hasLeveragedPatterns;
    if (isLeveraged) {
      categories.add("leveraged");
    }

    // ── 8. Total Market ──
    // Broad, diversified market exposure (e.g. VTI, VT, ACWI) vs narrow/sector funds.
    const isTotalMarketExplicit =
      focus.includes("total market") ||
      focus.includes("broad market") ||
      category.includes("total market");
    const isTotalMarketContent =
      /\b(total (?:stock )?market|total world|broad market|whole market|total international|broad equity|all[- ]?country|all[- ]?world|russell 3000|msci acwi|ftse developed|msci eafe)\b/i.test(
        `${name} ${focus} ${category} ${underlying} ${strategy} ${desc}`
      );
    const isTotalMarket = isTotalMarketExplicit || isTotalMarketContent;
    if (isTotalMarket) {
      categories.add("totalMarket");
    }

    // ── 9. Equity ──
    // Equity ETFs represent equity ownership: large cap, growth, value, dividends,
    // sectors, thematic, total market, etc.
    const isExplicitEquity =
      assetClass.includes("equity") ||
      focus.includes("equity") ||
      focus.includes("large cap") ||
      focus.includes("small cap") ||
      focus.includes("growth") ||
      focus.includes("value") ||
      focus.includes("dividend");
    const isCrypto = isBitcoin || isEthereum;
    // Pure physical commodity trusts (ETV) without equity holdings are not equity,
    // but equity mining funds (e.g. gold miners) or leveraged equities are equity.
    const isPurePhysicalCommodity =
      isCommodity &&
      type === "ETV" &&
      !isLeveraged &&
      !/miners|equity|stocks?/i.test(name);

    if (
      !isFixedIncome &&
      !isCrypto &&
      !isPurePhysicalCommodity &&
      (isExplicitEquity ||
        type === "ETF" ||
        /equity|stock|shares|index|cap|s&p|nasdaq|russell|dividend/i.test(name))
    ) {
      categories.add("equity");
    }

    return Array.from(categories);
  }
}
