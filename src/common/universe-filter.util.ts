/**
 * Generic universe filtering utilities for common equities.
 * Strictly driven by schema metadata, security types, descriptors, and sector completeness.
 * Strictly NO hardcoded ticker lists.
 */

export interface SecurityMetadata {
  ticker?: string | null;
  name?: string | null;
  sector?: string | null;
  type?: string | null;
  isEtf?: boolean | null;
  isFund?: boolean | null;
  isAdr?: boolean | null;
}

/**
 * Validates whether a security qualifies as a standard common equity or ADR
 * for Most Searched, Earnings Today, Screener Leaders, etc.
 *
 * Rules:
 * 1. Must carry a valid, assigned sector (excludes sector-less / unclassified symbols like "—", null, or "unknown").
 * 2. Excludes ETFs, ETNs, Funds based on `isEtf`, `isFund`, and `type`.
 * 3. Excludes Warrants, Rights, Units, Preferreds based on security `type`.
 * 4. Filters out derivative / fund descriptors in company name (ETF, Warrant, Preferred, Depositary Shares Preferred).
 */
export function isCommonEquity(item: SecurityMetadata | null | undefined): boolean {
  if (!item) return false;

  // 1. Sector requirement: Must have a real sector assigned
  const sec = item.sector?.trim();
  if (!sec || sec === "—" || sec.toLowerCase() === "unknown" || sec.toLowerCase() === "none") {
    return false;
  }

  // 2. Boolean flags from vendor metadata
  if (item.isEtf === true || item.isFund === true) {
    return false;
  }

  // 3. Type check (e.g. CS = common stock, ADRC = ADR common)
  const t = item.type?.trim().toUpperCase();
  if (t) {
    if (
      t === "ETF" ||
      t === "ETN" ||
      t === "FUND" ||
      t === "PFD" ||
      t === "PREF" ||
      t === "WARRANT" ||
      t === "RIGHT" ||
      t === "UNIT" ||
      t === "BOND"
    ) {
      return false;
    }
  }

  // 4. Name metadata descriptor checks (generic regex, no ticker lists)
  if (item.name) {
    if (
      /\b(ETF|ETN|Exchange[- ]Traded Fund|Warrants?|Preferred Stock|Perpetual Preferred|Depositary Shares.*Preferred)\b/i.test(
        item.name,
      )
    ) {
      return false;
    }
  }

  return true;
}
