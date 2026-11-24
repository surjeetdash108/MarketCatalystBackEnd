/**
 * Deduplicates multiple share classes for the same issuer (e.g. GOOG and GOOGL)
 * by grouping by SEC CIK.
 *
 * For issuers with multiple share classes listed, keeps the primary / largest market cap ticker.
 * This fixes the heatmap showing the same company multiple times (e.g. GOOG 3 times).
 */

export interface ConstituentItem {
  ticker: string;
  marketCap?: number | null;
  pctChange?: number | null;
  cik?: string | null;
  [key: string]: unknown;
}

export function groupShareClassesByCik<T extends ConstituentItem>(
  constituents: T[],
): T[] {
  const map = new Map<string, T>();

  for (const item of constituents) {
    if (!item.ticker) continue;
    // Normalized CIK key, or fallback to ticker if CIK is absent
    const key = item.cik
      ? `CIK_${String(item.cik).replace(/^0+/, "")}`
      : `TKR_${item.ticker}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
    } else {
      // Retain the one with larger market cap
      const existingCap = existing.marketCap ?? 0;
      const currentCap = item.marketCap ?? 0;
      if (currentCap > existingCap) {
        map.set(key, item);
      }
    }
  }

  return [...map.values()].sort(
    (a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0),
  );
}

/* ── Stock-map membership: funds out, one company once ───────────────────────
 *
 * No `companies` doc carries a `cik`, so grouping by CIK alone never merged
 * anything: on 24 Nov 2026 the heatmap showed Alphabet three times (GOOGL, GOOG
 * and GOOGM — a depositary share of an Alphabet PREFERRED, priced about $41 yet
 * carrying the whole company's $3.5T cap) and Berkshire twice (BRK.A $1.23T and
 * BRK.B at a class-only $0.8T), and 43 ETFs ($7.3T) sat in Finance. The same
 * rules run in the UI's buildSectorList and in sectors.job so both agree. */

/** Instrument types that are funds, not companies. */
const FUND_TYPES = new Set(["ETF", "ETN", "ETV", "FUND"]);

export function isFundType(type: string | null | undefined): boolean {
  return type != null && FUND_TYPES.has(String(type).toUpperCase());
}

/**
 * The issuer a listing belongs to: its CIK when the doc has one, else its name
 * with the class / depositary wording removed ("Alphabet Inc. Depository Shs
 * Repr 1/20th Conv Pfd" and "Alphabet Inc." both become "alphabetinc"), else
 * the ticker itself.
 */
export function issuerKey(item: {
  ticker: string;
  name?: string | null;
  cik?: string | null;
}): string {
  if (item.cik) return `CIK_${String(item.cik).replace(/^0+/, "")}`;
  const name = (item.name ?? "")
    .toLowerCase()
    .replace(/\b(depositary|depository|preferred|pfd)\b.*$/, "")
    .replace(/[,.]?\s*\b(class|series|cl)\s+[a-z0-9]\b.*$/, "")
    .replace(/[^a-z0-9]/g, "");
  return name.length >= 4 ? `NAME_${name}` : `TKR_${item.ticker}`;
}

/** A depositary share of a preferred, not the company's own common stock. */
function isDepositaryName(name: string | null | undefined): boolean {
  return /\b(depositary|depository|preferred|pfd)\b/i.test(name ?? "");
}

/**
 * Funds removed, then one listing per issuer: an ordinary listing over a
 * depositary / preferred one (GOOGM carries Alphabet's whole cap and would
 * otherwise win), then the largest cap. Call it within one sector so unrelated
 * companies that happen to share a name are never merged.
 */
export function dedupeIssuers<
  T extends {
    ticker: string;
    name?: string | null;
    cik?: string | null;
    type?: string | null;
    marketCap?: number | null;
  },
>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    if (!item.ticker || isFundType(item.type)) continue;
    const key = issuerKey(item);
    const cur = best.get(key);
    if (!cur) {
      best.set(key, item);
      continue;
    }
    const itemDepo = isDepositaryName(item.name);
    const curDepo = isDepositaryName(cur.name);
    if (itemDepo !== curDepo) {
      if (!itemDepo) best.set(key, item);
    } else if ((item.marketCap ?? 0) > (cur.marketCap ?? 0)) {
      best.set(key, item);
    }
  }
  return [...best.values()].sort(
    (a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0),
  );
}
