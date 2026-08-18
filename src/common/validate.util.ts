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
 * CONSERVATIVE by design: the stored value is kept whenever the two are within
 * 3× of each other (so multi-class names and normal drift are untouched); only a
 * gross discrepancy (>3×, i.e. clearly stale or a large recent move) is replaced
 * with the fresh figure. Returns the fresh value when the stored one is missing,
 * the stored value when the inputs for a fresh one are missing, else null.
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
  if (mc == null) return fresh;
  if (fresh == null) return mc;
  const ratio = fresh / mc;
  return ratio > 3 || ratio < 1 / 3 ? fresh : mc;
}
