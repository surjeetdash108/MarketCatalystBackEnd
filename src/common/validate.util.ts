/**
 * Tiny, dependency-free numeric guards for the vendor boundary.
 *
 * Vendors occasionally emit `NaN`, `Infinity`, split-adjusted floats, or
 * negative counts where a real number is expected. `Math.round(NaN)` is `NaN`
 * and `Number(x) || null` silently drops a legitimate `0`, so both propagate
 * bad values into stored/served data. These helpers are the single, explicit
 * coercion used at every parse boundary instead of ad-hoc `typeof === "number"`
 * checks that let `NaN`/`Infinity`/negatives through.
 */

/** The value when it is a finite number (`NaN`/`±Infinity` → null). Keeps `0`
 *  and negatives, which are legitimate for prices/changes. */
export function finiteOrNull(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** A non-negative integer (rounded), else null. For share counts / volume where
 *  a fractional (split-adjusted) or negative value is never valid. */
export function nonNegIntOrNull(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.round(n)
    : null;
}

/**
 * Reconcile a vendor's reference market cap with a freshly-computed one.
 *
 * Polygon's `market_cap` is shares × a reference close refreshed on its own
 * cadence, so a volatile name can carry a badly stale value — e.g. a sub-$10B
 * small cap stored at ≥$10B, which then slips through a "market cap > $10B"
 * screen. `price × weighted_shares_outstanding` is the current-price estimate.
 *
 * The fresh figure wins whenever price and share count are both known; the
 * stored value is the fallback when they are not, else null.
 */
export function reconcileMarketCap(
  storedMarketCap: unknown,
  price: unknown,
  weightedShares: unknown,
): number | null {
  const mc =
    typeof storedMarketCap === "number" &&
    Number.isFinite(storedMarketCap) &&
    storedMarketCap > 0
      ? storedMarketCap
      : null;
  const fresh =
    typeof price === "number" &&
    Number.isFinite(price) &&
    price > 0 &&
    typeof weightedShares === "number" &&
    Number.isFinite(weightedShares) &&
    weightedShares > 0
      ? price * weightedShares
      : null;
  // The current-price figure whenever it can be computed: keeping the stored
  // value "within 3×" kept ordinary staleness too (BGS $165M / EPM $155M / PNRG
  // $334M against $170.7M / $157.9M / $341.4M at the day's close, E2E Oct 23).
  return fresh ?? mc;
}
