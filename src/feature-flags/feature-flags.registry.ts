/**
 * Canonical feature-flag registry (delivery-plan R6).
 *
 * ONE source of truth for every FF_* flag named in the weekly delivery plan.
 * A flag not listed here is unknown — the API rejects reads/writes for it so a
 * typo can't silently create a phantom flag that is neither on nor off.
 *
 * Resolution order (lowest → highest precedence):
 *   1. `defaultOn` here        — safe baseline shipped in code
 *   2. env var `FF_<NAME>`     — deploy-time override (true/false/1/0/on/off)
 *   3. Firestore feature_flags — runtime override, flips WITHOUT a redeploy
 *
 * The Firestore layer is what makes a release "toggle independently": flip its
 * flag in the `feature_flags/default` doc and every client reacts live.
 */

export interface FeatureFlagDef {
  /** FF_* key. Matches the delivery-plan "Release gate (flag)" column. */
  key: string;
  /** Delivery-plan row this flag gates. */
  row: string;
  /** Human label for the admin UI. */
  label: string;
  /**
   * Baseline when nothing overrides it. A feature is `defaultOn: true` only
   * once it is actually built and live — everything still fabricated or
   * unbuilt ships OFF so a flag flip is the deliberate act of releasing it.
   */
  defaultOn: boolean;
}

export const FEATURE_FLAGS: FeatureFlagDef[] = [
  // ── W1 — live ────────────────────────────────────────────────────────────
  { key: "FF_MOVERS", row: "R9", label: "Market Movers", defaultOn: true },
  { key: "FF_HEATMAP", row: "R10", label: "Market Heatmap", defaultOn: true },
  {
    key: "FF_DASHBOARD",
    row: "R11",
    label: "Dashboard core widgets",
    defaultOn: true,
  },
  // ── W2 — live ────────────────────────────────────────────────────────────
  { key: "FF_MACRO", row: "R13", label: "Macro & VIX", defaultOn: true },
  { key: "FF_IPOS", row: "R14", label: "IPO Corner", defaultOn: true },
  { key: "FF_NEWS", row: "R15", label: "Commentary / News", defaultOn: true },
  { key: "FF_THEMES", row: "R16", label: "Sector Themes", defaultOn: true },
  {
    key: "FF_NAMESEARCH",
    row: "R17",
    label: "Company-name search",
    defaultOn: true,
  },
  // ── W3 — live ────────────────────────────────────────────────────────────
  {
    key: "FF_PORTFOLIO",
    row: "R19",
    label: "Portfolio Pulse",
    defaultOn: true,
  },
  { key: "FF_WATCHLIST", row: "R20", label: "Watchlist", defaultOn: true },
  // ── W4 — partially live ──────────────────────────────────────────────────
  { key: "FF_STOCKDETAIL", row: "R24", label: "Stock Detail", defaultOn: true },
  { key: "FF_SCREENER", row: "R25", label: "Screener", defaultOn: true },
  {
    key: "FF_FEARGREED",
    row: "R26",
    label: "Fear & Greed gauge",
    defaultOn: true,
  },
  // ── W5+ — not yet built: default OFF until their row is delivered ─────────
  {
    key: "FF_RECAPS_DATA",
    row: "R28",
    label: "Recaps EOD data",
    defaultOn: false,
  },
  {
    key: "FF_EPSHIST",
    row: "R29",
    label: "10-quarter EPS history",
    defaultOn: false,
  },
  {
    key: "FF_OPTIONS",
    row: "R32",
    label: "Options Chain (greeks/IV/OI)",
    defaultOn: false,
  },
  {
    key: "FF_AI_WMN",
    row: "R35",
    label: "Dashboard 'What Matters Now' AI",
    defaultOn: false,
  },
  {
    key: "FF_AI_RECAPS",
    row: "R36",
    label: "Recaps AI narrative",
    defaultOn: false,
  },
  {
    key: "FF_AI_STOCK",
    row: "R38",
    label: "Stock Detail AI",
    defaultOn: false,
  },
  { key: "FF_AI_MISC", row: "R39", label: "Misc AI notes", defaultOn: false },
  {
    key: "FF_ANALYST_EVENTS",
    row: "R41",
    label: "Analyst per-firm events",
    defaultOn: false,
  },
  {
    key: "FF_EARNINGS_DEPTH",
    row: "R42",
    label: "Earnings depth",
    defaultOn: false,
  },
  {
    key: "FF_OPTIONS_FLOW",
    row: "R43",
    label: "Options flow / dark pool",
    defaultOn: false,
  },
  { key: "FF_ALERTS", row: "R44", label: "Alerts engine", defaultOn: false },
  {
    key: "FF_REAL_CALENDARS",
    row: "R47",
    label: "Real date-range calendars",
    defaultOn: true,
  },
];

export const FEATURE_FLAG_KEYS = new Set(FEATURE_FLAGS.map((f) => f.key));

/** Parses an env/string value into a boolean, or null if unset/unrecognised. */
export function parseFlag(raw: string | undefined): boolean | null {
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  return null;
}
