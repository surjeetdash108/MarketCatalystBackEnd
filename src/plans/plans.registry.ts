/**
 * Subscription plans and the entitlement keys they grant.
 *
 * TWO SEPARATE AXES — do not merge them (see entitlements.service.ts):
 *
 *   FF_* release flags (feature-flags.registry.ts)  "is this built and shipped?"
 *   entitlements here                               "may this tier use it?"
 *
 * A feature is usable only when BOTH say yes. Collapsing them into one set
 * would make an unbuilt feature indistinguishable from a paywalled one, and the
 * UI has to say very different things: "coming soon" vs "upgrade to unlock".
 *
 * This registry is the SEED, not the source of truth at runtime. Plans live in
 * the `plans` Firestore collection so pricing and entitlements can change
 * without a redeploy — which is the whole point of requirement 1. Seeding is
 * merge-based, so hand-edits in Firestore survive a re-seed of unrelated fields.
 */

/**
 * Every gateable module in the app. Keys match the requirement's suggested
 * list. Adding one here does NOT hide anything by itself — a feature only
 * disappears once a plan sets it false AND the UI gates on it.
 */
export interface EntitlementDef {
  key: string;
  /** Short human name shown in the admin toggle list. */
  label: string;
  /**
   * ONE plain sentence describing what the user gets when this is ON.
   * Written for a non-engineer deciding plan packaging, so it names the screen
   * or capability rather than the code path. Keep it to one line.
   */
  description: string;
  /** Section heading in the admin editor. */
  group: string;
  /** Staff capability — never sold with a plan. */
  staffOnly?: boolean;
  /** No implementation exists yet; hidden in the app and never sold. */
  unbuilt?: boolean;
  /** Short qualifier shown next to the label, e.g. "some data simulated". */
  note?: string;
}

/**
 * Every gateable capability, at the granularity a plan is actually sold on.
 *
 * Deliberately finer-grained than the requirement's original 16: "advancedCharts"
 * bundled intraday data, long history, indicators and drawing into one switch,
 * so packaging could not separate a chart a day-trader needs (intraday) from one
 * a long-term investor needs (5-year). Each row below is something a customer
 * could plausibly be given or denied on its own.
 */
export const ENTITLEMENTS: EntitlementDef[] = [
  // ── Core market data (Free) ───────────────────────────────────────────────
  {
    key: "marketCatalyst",
    label: "Market Dashboard",
    group: "Core",
    description:
      "See the main dashboard with market pulse, movers and heatmap.",
  },
  {
    key: "news",
    label: "News & Commentary",
    group: "Core",
    description: "Read the live news feed and commentary screen.",
  },
  {
    key: "scanner",
    label: "Market Movers",
    group: "Core",
    description: "See daily gainers, losers and unusual-volume lists.",
  },
  {
    key: "heatmap",
    label: "Sector Heatmap",
    group: "Core",
    description: "View the sector and stock heatmap with day/week performance.",
  },
  {
    key: "macro",
    label: "Macro & Calendars",
    group: "Core",
    description: "Access the economic calendar, VIX and dividend calendars.",
  },
  {
    key: "ipos",
    label: "IPO Corner",
    group: "Core",
    description: "Browse upcoming and recent IPOs with offer prices.",
  },
  {
    key: "chartsDaily",
    label: "Daily Charts",
    group: "Charting",
    description: "View 3-month, 6-month and 1-year price charts.",
  },
  {
    key: "watchlist",
    label: "Watchlist",
    group: "My Money",
    description: "Build and track a personal watchlist of stocks.",
  },

  // ── Starter ───────────────────────────────────────────────────────────────
  {
    key: "workspaces",
    label: "All 15 Workspaces",
    group: "Core",
    description:
      "Open every Market Desk workspace, including Analyst Actions, Recaps, ETF Corner and AI Companies.",
  },
  {
    key: "chartsIntraday",
    label: "Intraday Charts",
    group: "Charting",
    description:
      "View 1-day, 1-week and 1-month charts built from minute bars.",
  },
  {
    key: "chartsHistory",
    label: "Long History (5Y)",
    group: "Charting",
    description: "View the full five-year price history on any chart.",
  },
  {
    key: "chartIndicators",
    label: "Chart Indicators",
    group: "Charting",
    description: "Overlay moving averages, EMAs, volume and the RSI pane.",
  },
  {
    key: "chartNotes",
    label: "Chart Notes",
    group: "Charting",
    description: "Save personal notes pinned to a chart.",
  },
  {
    key: "screener",
    label: "Stock Screener",
    group: "Research",
    description:
      "Filter the universe by growth, technical and liquidity criteria.",
  },
  {
    key: "ownership",
    label: "13F & Insider",
    group: "Research",
    description: "See insider trades and institutional fund holdings.",
  },
  {
    key: "technicalRatings",
    label: "Technical Ratings",
    group: "Research",
    description:
      "See the technical rating gauge, RSI, MACD and moving-average table.",
  },
  {
    key: "fundamentalRatings",
    label: "Financial Statements",
    group: "Research",
    description: "See quarterly revenue, EPS, balance sheet and cash flow.",
  },
  {
    key: "dividendHistory",
    label: "Dividend History",
    group: "Research",
    description:
      "See full dividend history, yield, growth rate and payment dates.",
  },
  {
    key: "peers",
    label: "Peer Comparison",
    group: "Research",
    description:
      "See comparable companies and how the stock ranks against them.",
  },
  {
    key: "earningsDetail",
    label: "Earnings Detail",
    group: "Research",
    description:
      "See EPS history, estimate-vs-actual, transcripts and the earnings calendar.",
  },
  {
    key: "aiAssistant",
    label: "AI Research",
    group: "Research",
    description:
      "Ask the AI copilot questions and read AI-generated stock research.",
  },
  {
    key: "tradeTracker",
    label: "Trade Builder & Tracker",
    group: "My Money",
    description:
      "Build trades with entry, stop and target and track them over time.",
  },
  {
    key: "portfolio",
    label: "Portfolio Tracking",
    group: "My Money",
    description: "Track holdings with live prices and profit/loss.",
  },
  {
    key: "themes",
    label: "Sector Themes",
    group: "My Money",
    description: "Browse curated theme baskets such as Mag7 and AI & Semis.",
  },

  // ── Pro ───────────────────────────────────────────────────────────────────
  {
    key: "moneyFlow",
    label: "Money Flow",
    group: "Institutional",
    description: "See where institutional money is moving, by sector.",
  },
  {
    key: "institutionalMovers",
    label: "Institutional Movers",
    group: "Institutional",
    description: "See the biggest institutional gainers and losers.",
  },
  {
    key: "optionsChain",
    label: "Options Chain",
    group: "Institutional",
    description:
      "View the options chain with strikes, expirations and traded prices.",
    note: "some data simulated",
  },

  // ── Elite ─────────────────────────────────────────────────────────────────
  {
    key: "strategyLab",
    label: "Strategy Lab",
    group: "Strategy",
    description:
      "Build strategies from presets or plain English and get entry, stop and target levels.",
  },
  {
    key: "backtesting",
    label: "Backtesting",
    group: "Strategy",
    description:
      "Backtest any strategy against historical prices before you trade.",
  },

  // ── Not built: hidden everywhere, never sold ─────────────────────────────
  {
    key: "alerts",
    label: "Price Alerts",
    group: "Unbuilt",
    description:
      "Create alerts that fire when a price or signal condition is met.",
    unbuilt: true,
  },
  {
    key: "exportData",
    label: "Data Export",
    group: "Unbuilt",
    description: "Download screens and recaps as PDF or CSV.",
    unbuilt: true,
  },
  {
    key: "apiAccess",
    label: "API Access",
    group: "Unbuilt",
    description: "Call the market-data API from your own scripts with a key.",
    unbuilt: true,
  },
  {
    key: "paperTrading",
    label: "Paper Trading",
    group: "Unbuilt",
    description: "Place simulated trades without real money.",
    unbuilt: true,
  },

  // ── Staff only ────────────────────────────────────────────────────────────
  {
    key: "adminDashboard",
    label: "Admin Console",
    group: "Staff",
    description: "Open the admin console with revenue and user analytics.",
    staffOnly: true,
  },
  {
    key: "userManagement",
    label: "User Management",
    group: "Staff",
    description: "View and manage other users’ accounts and subscriptions.",
    staffOnly: true,
  },
];

export const ENTITLEMENT_KEYS = ENTITLEMENTS.map(
  (e) => e.key,
) as unknown as readonly string[];

export type EntitlementKey = string;

export type BillingInterval = "monthly" | "annual";
export const BILLING_INTERVALS: BillingInterval[] = ["monthly", "annual"];

/** Kept for the admin console's per-plan display; `prices` is authoritative. */
export type BillingCycle = "monthly" | "yearly" | "none";

export interface PlanPrice {
  /** Minor units (cents), Stripe's convention. */
  amount: number;
  /** Stripe Price lookup key; the provider resolves the real Price by it. */
  lookupKey: string;
}

export interface PlanLimits {
  /** Tickers per watchlist; null = unlimited. */
  watchlistTickers: number | null;
}

export interface PlanDefinition {
  id: string;
  name: string;
  /** Monthly list price, minor units — mirrors prices.monthly for older readers. */
  amount: number;
  currency: string;
  billingCycle: BillingCycle;
  description: string;
  featureFlags: Record<EntitlementKey, boolean>;
  active: boolean;
  /** Display order and upgrade rank; lower first. */
  sortOrder: number;
  /** Legacy single price id; superseded by prices[interval].lookupKey. */
  stripePriceId: string | null;
  /** One price per billing interval; absent for Free. */
  prices: Partial<Record<BillingInterval, PlanPrice>>;
  limits: PlanLimits;
}

/**
 * Bumped whenever the commercial catalog (plans, prices, entitlement grants)
 * changes. PlansService.seed() rewrites plan documents stored under an older
 * version, so a deploy is what changes production prices — never a stale doc.
 */
export const CATALOG_VERSION = 2;

/** Plan ids that existed before and must be deactivated on seed. */
export const RETIRED_PLAN_IDS = ["plus"];

function allEntitlements(value: boolean): Record<EntitlementKey, boolean> {
  return Object.fromEntries(ENTITLEMENT_KEYS.map((k) => [k, value]));
}

const NEVER_GRANTED: EntitlementKey[] = ENTITLEMENTS.filter(
  (e) => e.staffOnly || e.unbuilt,
).map((e) => e.key);

/** The tier ladder (doc Step 1). Cumulative: each tier adds to the one below. */
const FREE_GRANTS: EntitlementKey[] = [
  "marketCatalyst",
  "news",
  "scanner",
  "heatmap",
  "macro",
  "ipos",
  "chartsDaily",
  "watchlist",
];
const STARTER_ADDS: EntitlementKey[] = [
  "workspaces",
  "chartsIntraday",
  "chartsHistory",
  "chartIndicators",
  "chartNotes",
  "screener",
  "ownership",
  "technicalRatings",
  "fundamentalRatings",
  "dividendHistory",
  "peers",
  "earningsDetail",
  "aiAssistant",
  "tradeTracker",
  "portfolio",
  "themes",
];
const PRO_ADDS: EntitlementKey[] = [
  "moneyFlow",
  "institutionalMovers",
  "optionsChain",
];
const ELITE_ADDS: EntitlementKey[] = ["strategyLab", "backtesting"];

function grants(granted: EntitlementKey[]): Record<EntitlementKey, boolean> {
  const flags = allEntitlements(false);
  for (const k of granted) flags[k] = true;
  for (const k of NEVER_GRANTED) flags[k] = false;
  return flags;
}

const price = (amount: number, lookupKey: string): PlanPrice => ({
  amount,
  lookupKey,
});

export const PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    id: "free",
    name: "Free",
    amount: 0,
    currency: "USD",
    billingCycle: "none",
    description: "Core market screens, daily charts and a watchlist.",
    featureFlags: grants(FREE_GRANTS),
    active: true,
    sortOrder: 0,
    stripePriceId: null,
    prices: {},
    limits: { watchlistTickers: 5 },
  },
  {
    id: "starter",
    name: "Starter",
    amount: 3900,
    currency: "USD",
    billingCycle: "monthly",
    description:
      "For investors who want the daily picture and research on any stock.",
    featureFlags: grants([...FREE_GRANTS, ...STARTER_ADDS]),
    active: true,
    sortOrder: 1,
    stripePriceId: null,
    prices: {
      monthly: price(3900, "starter_monthly"),
      annual: price(37440, "starter_annual"),
    },
    limits: { watchlistTickers: null },
  },
  {
    id: "pro",
    name: "Pro",
    amount: 5900,
    currency: "USD",
    billingCycle: "monthly",
    description:
      "For active traders who want to see where institutions are moving.",
    featureFlags: grants([...FREE_GRANTS, ...STARTER_ADDS, ...PRO_ADDS]),
    active: true,
    sortOrder: 2,
    stripePriceId: null,
    prices: {
      monthly: price(5900, "pro_monthly"),
      annual: price(56640, "pro_annual"),
    },
    limits: { watchlistTickers: null },
  },
  {
    id: "elite",
    name: "Elite",
    amount: 19900,
    currency: "USD",
    billingCycle: "monthly",
    description: "For traders who backtest before every trade.",
    featureFlags: grants([
      ...FREE_GRANTS,
      ...STARTER_ADDS,
      ...PRO_ADDS,
      ...ELITE_ADDS,
    ]),
    active: true,
    sortOrder: 3,
    stripePriceId: null,
    prices: {
      monthly: price(19900, "elite_monthly"),
      annual: price(179100, "elite_annual"),
    },
    limits: { watchlistTickers: null },
  },
];

/** The plan assigned to a user who has never paid. */
export const DEFAULT_PLAN_ID = "free";

export type SubscriptionStatus =
  "ACTIVE" | "EXPIRED" | "CANCELLED" | "PAST_DUE" | "TRIALING" | "NONE";

/** Days a PAST_DUE subscription keeps paid access while payment is retried. */
export const PAST_DUE_GRACE_DAYS = 7;

export function planById(
  id: string | null | undefined,
): PlanDefinition | undefined {
  return PLAN_DEFINITIONS.find((p) => p.id === id);
}

/** Upgrade rank: higher = more expensive tier. Unknown plans rank as Free. */
export function planRank(id: string | null | undefined): number {
  return planById(id)?.sortOrder ?? 0;
}

export function isPaidPlanId(id: string | null | undefined): boolean {
  const p = planById(id);
  return !!p && p.id !== DEFAULT_PLAN_ID && Object.keys(p.prices).length > 0;
}

/** The cheapest plan that grants `key`, for "Available on <plan>" messages. */
export function lowestPlanFor(key: EntitlementKey): PlanDefinition | undefined {
  return [...PLAN_DEFINITIONS]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .find((p) => p.featureFlags[key] === true);
}

/** Catalog price for a plan × interval; undefined for Free or unknown. */
export function catalogPrice(
  planId: string,
  interval: BillingInterval,
): PlanPrice | undefined {
  return planById(planId)?.prices[interval];
}
