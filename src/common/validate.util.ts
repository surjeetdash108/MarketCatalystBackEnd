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
