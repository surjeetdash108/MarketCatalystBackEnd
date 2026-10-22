import { fromFmpSymbol } from "../vendors/market-data/fmp-mapping.util";
import { etDate } from "./market-calendar.util";

/**
 * Insider-transaction rows in the `insider_transactions` shape the UI reads
 * (`InsiderTxDoc`), built from either vendor: FMP's insider-trading feed
 * (primary) or a parsed SEC Form 4 (backup, and the nightly sec-form4 job).
 */

// Form 4 price fields occasionally carry a garbage per-share value (a footnote
// artifact, or a total dollar amount landing in the price field) — e.g. a
// $2,110,482/sh row that fabricates a multi-billion-dollar transaction. No US
// equity trades near this: the priciest (BRK.A) is well under $1M/sh, so any
// per-share price above the ceiling is discarded (null) rather than stored.
export const MAX_PLAUSIBLE_SHARE_PRICE = 1_000_000;

export interface InsiderRow {
  id: string;
  ticker: string;
  issuerName: string | null;
  ownerName: string | null;
  isOfficer: boolean;
  officerTitle: string | null;
  transactionDate: string;
  transactionCode: string;
  acquiredOrDisposed: string;
  shares: number;
  pricePerShare: number | null;
  sharesOwnedAfter: number | null;
  filingDate: string | null;
  /** SEC filing link when the vendor gives one (FMP does). */
  url?: string | null;
  vendor: "fmp" | "sec";
}

/**
 * A Form 4 reports trades that have already happened, so a row dated after its
 * own filing — or after today — is a vendor artifact, not a trade. ETN carried
 * two such FMP rows (2027-01-01, 2027-02-25) as if they were real.
 */
function isFutureDated(
  transactionDate: string,
  filingDate: string | null,
): boolean {
  return (
    (filingDate != null && transactionDate > filingDate) ||
    transactionDate > etDate()
  );
}

/** Positive, plausible per-share price, else null — never a fabricated dollar value. */
export function plausiblePrice(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= MAX_PLAUSIBLE_SHARE_PRICE ? n : null;
}

/** "director, officer: Chief Executive Officer" → "Chief Executive Officer"; "director" → "Director". */
function roleFromFmpOwnerType(typeOfOwner: string): string | null {
  const officer = /officer:\s*([^,]+)/i.exec(typeOfOwner)?.[1]?.trim();
  if (officer) return officer;
  if (/director/i.test(typeOfOwner)) return "Director";
  if (/10 percent owner/i.test(typeOfOwner)) return "10% owner";
  if (/officer/i.test(typeOfOwner)) return "Officer";
  return null;
}

/**
 * FMP `/stable/insider-trading/search` rows → InsiderRow. Rows with no
 * transacted shares (Form 3 initial-holding statements) are dropped: they
 * record a position, not a trade.
 */
export function fmpInsiderRows(ticker: string, rows: Record<string, unknown>[]): InsiderRow[] {
  const out: InsiderRow[] = [];
  rows.forEach((r, i) => {
    const shares = Number(r.securitiesTransacted);
    const date = String(r.transactionDate ?? "").slice(0, 10);
    if (!(shares > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const typeOfOwner = String(r.typeOfOwner ?? "");
    // "G-Gift" → "G": the SEC transaction code the UI labels.
    const code = String(r.transactionType ?? "").split("-")[0].trim();
    const filingDate = r.filingDate ? String(r.filingDate).slice(0, 10) : null;
    if (isFutureDated(date, filingDate)) return;
    const owned = Number(r.securitiesOwned);
    out.push({
      // Stable across refreshes for the same filing line.
      id: `fmp_${r.reportingCik ?? "x"}_${filingDate ?? "x"}_${date}_${code}_${shares}_${i}`,
      // The caller's ticker when given (per-stock feeds, already in app form,
      // e.g. "BRK.B"); otherwise the row's own symbol converted from FMP's
      // class-share spelling ("BRK-B" → "BRK.B") so it matches the rest of the app.
      ticker: ticker || fromFmpSymbol(String(r.symbol ?? "").toUpperCase()),
      issuerName: r.companyName ? String(r.companyName) : null,
      ownerName: r.reportingName ? String(r.reportingName) : null,
      isOfficer: /officer/i.test(typeOfOwner),
      officerTitle: roleFromFmpOwnerType(typeOfOwner),
      transactionDate: date,
      transactionCode: code,
      acquiredOrDisposed: String(r.acquisitionOrDisposition ?? ""),
      shares,
      pricePerShare: plausiblePrice(r.price),
      sharesOwnedAfter: Number.isFinite(owned) && owned >= 0 ? owned : null,
      filingDate,
      url: r.url ? String(r.url) : null,
      vendor: "fmp",
    });
  });
  return out;
}

/** One parsed SEC Form 4 (SecEdgarService.getForm4Transactions) → InsiderRow per transaction. */
export function form4InsiderRows(
  ticker: string,
  accessionNumber: string,
  filingDate: string | null,
  parsed: {
    issuer: { ticker?: string; name?: string } | null;
    owner: { name?: string; isOfficer: boolean; officerTitle: string | null } | null;
    transactions: any[];
  },
): InsiderRow[] {
  const { issuer, owner, transactions } = parsed;
  const rows: InsiderRow[] = transactions.map((t, i) => ({
    id: `${accessionNumber}_${i}`,
    ticker: issuer?.ticker ?? ticker,
    issuerName: issuer?.name ?? null,
    ownerName: owner?.name ?? null,
    isOfficer: owner?.isOfficer ?? false,
    officerTitle: owner?.officerTitle ?? null,
    transactionDate: t.transactionDate?.value,
    transactionCode: t.transactionCoding?.transactionCode,
    acquiredOrDisposed: t.transactionAmounts?.transactionAcquiredDisposedCode?.value,
    shares: Number(t.transactionAmounts?.transactionShares?.value) || 0,
    pricePerShare: plausiblePrice(t.transactionAmounts?.transactionPricePerShare?.value),
    sharesOwnedAfter:
      Number(t.postTransactionAmounts?.sharesOwnedFollowingTransaction?.value) || null,
    filingDate,
    vendor: "sec",
  }));
  return rows.filter((r) => !isFutureDated(r.transactionDate, filingDate));
}
