/**
 * ADR (American Depositary Receipt) ratio and Foreign Currency conversion utilities.
 * Handles foreign issuers (e.g. MFG, TSM, BABA) reporting in non-USD currencies
 * and multi-share ADR ratios, standardizing EPS, P/E, surprises, and financial statements
 * to USD per ADR.
 */

import type { CanonicalFinancialStatement } from "../adapters/types";

/**
 * Standard USD conversion rates per 1 unit of foreign currency.
 * Used as reliable conversion rates when real-time FX pairs are offline or during statement mapping.
 */
export const FX_RATES_TO_USD: Record<string, number> = {
  USD: 1.0,
  JPY: 1 / 156.8, // ~0.0063776
  EUR: 1.085,
  GBP: 1.30,
  CAD: 0.73,
  TWD: 1 / 32.2, // ~0.03105
  CHF: 1.14,
  CNY: 0.14,
  HKD: 0.1285,
  AUD: 0.655,
  BRL: 0.18,
  KRW: 1 / 1380, // ~0.0007246
  INR: 1 / 84.0, // ~0.0119
  MXN: 0.052,
  SGD: 0.76,
  SEK: 0.095,
  NOK: 0.093,
  ILS: 0.27,
};

const FRACTION_WORDS: Record<string, number> = {
  half: 0.5,
  third: 1 / 3,
  fourth: 0.25,
  quarter: 0.25,
  fifth: 0.2,
  sixth: 1 / 6,
  seventh: 1 / 7,
  eighth: 0.125,
  ninth: 1 / 9,
  tenth: 0.1,
  twentieth: 0.05,
  fiftieth: 0.02,
  hundredth: 0.01,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twenty: 20,
  fifty: 50,
  hundred: 100,
};

/**
 * Parses ADR ratio (ordinary shares represented per 1 ADR) from security metadata or name.
 * e.g. "American Depositary Shares (Each representing one-fifth of an Ordinary Share)" -> 0.2
 * e.g. "(Each representing 2 Ordinary Shares)" -> 2
 * e.g. "1/5" -> 0.2
 * Defaults to 1.0 if not specified.
 */
export function parseAdrRatio(nameOrDescription: string | null | undefined): number {
  if (!nameOrDescription) return 1.0;
  const s = nameOrDescription.toLowerCase();

  // Pattern 1: "one-fifth", "one fifth", "two-thirds"
  for (const [fracWord, fracVal] of Object.entries(FRACTION_WORDS)) {
    const rx = new RegExp(`(?:one[- ]|1\\/)${fracWord}`, "i");
    if (rx.test(s)) {
      return fracVal;
    }
  }

  // Pattern 2: numeric fractions like "1/5", "1 / 5", "2/1"
  const fractionMatch = s.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (fractionMatch) {
    const num = parseFloat(fractionMatch[1]);
    const denom = parseFloat(fractionMatch[2]);
    if (denom > 0) return num / denom;
  }

  // Pattern 3: "representing X ordinary/common" where X is a number
  const numMatch = s.match(/(?:representing|equal to)\s*(\d+(?:\.\d+)?)\s*(?:ordinary|common)/i);
  if (numMatch) {
    const n = parseFloat(numMatch[1]);
    if (n > 0) return n;
  }

  // Pattern 4: "representing X ordinary/common" where X is a word like "two", "ten"
  for (const [word, val] of Object.entries(NUMBER_WORDS)) {
    const rx = new RegExp(`(?:representing|equal to)\\s*${word}\\s*(?:ordinary|common)`, "i");
    if (rx.test(s)) {
      return val;
    }
  }

  return 1.0;
}

/**
 * Resolves conversion factor from foreign currency to USD.
 */
export function getFxRateToUsd(currency: string | null | undefined): number {
  if (!currency) return 1.0;
  const c = currency.trim().toUpperCase();
  return FX_RATES_TO_USD[c] ?? 1.0;
}

/**
 * Normalizes reported EPS to USD per ADR.
 */
export function convertEpsToUsdPerAdr(params: {
  reportedEps: number | null | undefined;
  currency?: string | null;
  adrRatio?: number;
}): number | null {
  const { reportedEps, currency, adrRatio = 1.0 } = params;
  if (reportedEps == null || Number.isNaN(reportedEps)) return null;

  const c = currency?.trim().toUpperCase();
  const fx = getFxRateToUsd(c);
  // (Reported EPS * ADR ratio) converted to USD
  const converted = reportedEps * adrRatio * fx;
  return Math.round(converted * 10000) / 10000;
}

const PER_SHARE_KEYS = new Set([
  "diluted_earnings_per_share",
  "basic_earnings_per_share",
  "dilutedEps",
  "basicEps",
]);

/**
 * Converts a financial statement reported in foreign currency to USD:
 * - Aggregates (Revenues, Net Income, Total Assets, Total Debt, Free Cash Flow) are multiplied by FX rate.
 * - Per-share lines (EPS) are multiplied by (FX rate * ADR ratio).
 */
export function convertFinancialStatementToUsd(params: {
  statement: CanonicalFinancialStatement;
  currency?: string | null;
  adrRatio?: number;
}): CanonicalFinancialStatement {
  const { statement, currency, adrRatio = 1.0 } = params;
  const c = currency?.trim().toUpperCase();
  if (!c || c === "USD") return statement;

  const fx = getFxRateToUsd(c);

  const convertBlock = (
    block: Record<string, number | null> | undefined,
    isIncome = false,
  ): Record<string, number | null> => {
    if (!block) return {};
    const res: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(block)) {
      if (v == null || Number.isNaN(v)) {
        res[k] = null;
        continue;
      }
      if (isIncome && PER_SHARE_KEYS.has(k)) {
        res[k] = Math.round(v * adrRatio * fx * 10000) / 10000;
      } else {
        res[k] = Math.round(v * fx);
      }
    }
    return res;
  };

  return {
    ...statement,
    income: convertBlock(statement.income, true),
    balanceSheet: convertBlock(statement.balanceSheet, false),
    cashFlow: convertBlock(statement.cashFlow, false),
  };
}
