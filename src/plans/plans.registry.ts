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
  /** Section heading in the admin editor (the feature group's name for sold features). */
  group: string;
  /** The feature group that sells this capability; absent for unbuilt/staff rows. */
  featureGroup?: FeatureGroupId;
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
  // ── Market Catalyst (Starter and up) ──────────────────────────────────────────
  {
    key: "marketCatalyst",
    label: "Market Dashboard",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description:
      "See the main dashboard with market pulse, movers and heatmap.",
  },
  {
    key: "news",
    label: "News & Commentary",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description: "Read the live news feed and commentary screen.",
  },
  {
    key: "scanner",
    label: "Market Movers",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description: "See daily gainers, losers and unusual-volume lists.",
  },
  {
    key: "heatmap",
    label: "Sector Heatmap",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description: "View the sector and stock heatmap with day/week performance.",
  },
  {
    key: "macro",
    label: "Macro & Calendars",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description: "Access the economic calendar, VIX and dividend calendars.",
  },
  {
    key: "ipos",
    label: "IPO Corner",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description: "Browse upcoming and recent IPOs with offer prices.",
  },
  {
    key: "earningsHub",
    label: "Earnings Hub",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description:
      "See the earnings calendar and the latest earnings announcements.",
  },
  {
    key: "recaps",
    label: "Market Recaps",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description: "Read the daily and weekly market recaps.",
  },
  // ── Stock Intelligence (Starter and up) ───────────────────────────────────
  {
    key: "stockIntelligence",
    label: "Stock Intelligence",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description:
      "Open any stock's page: quote, profile, news and key statistics.",
  },
  {
    key: "chartsDaily",
    label: "Daily Charts",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description: "View 3-month, 6-month and 1-year price charts.",
  },
  {
    key: "watchlist",
    label: "Watchlist",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description: "Build and track a personal watchlist of stocks.",
  },

  // ── Starter ───────────────────────────────────────────────────────────────
  {
    key: "workspaces",
    label: "All workspaces",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description:
      "Open every Market Catalyst workspace, including Analyst Actions, Recaps, ETF Corner and AI Companies.",
  },
  {
    key: "chartsIntraday",
    label: "Intraday Charts",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description:
      "View 1-day, 1-week and 1-month charts built from minute bars.",
  },
  {
    key: "chartsHistory",
    label: "Long History (5Y)",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description: "View the full five-year price history on any chart.",
  },
  {
    key: "chartIndicators",
    label: "Chart Indicators",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description: "Overlay moving averages, EMAs, volume and the RSI pane.",
  },
  {
    key: "chartNotes",
    label: "Chart Notes",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description: "Save personal notes pinned to a chart.",
  },
  {
    key: "screener",
    label: "Stock Screener",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description:
      "Filter the universe by growth, technical and liquidity criteria.",
  },
  {
    key: "ownership",
    label: "13F & Insider",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description: "See insider trades and institutional fund holdings.",
  },
  {
    key: "technicalRatings",
    label: "Technical Ratings",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description:
      "See the technical rating gauge, RSI, MACD and moving-average table.",
  },
  {
    key: "fundamentalRatings",
    label: "Financial Statements",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description: "See quarterly revenue, EPS, balance sheet and cash flow.",
  },
  {
    key: "dividendHistory",
    label: "Dividend History",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description:
      "See full dividend history, yield, growth rate and payment dates.",
  },
  {
    key: "peers",
    label: "Peer Comparison",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description:
      "See comparable companies and how the stock ranks against them.",
  },
  {
    key: "earningsDetail",
    label: "Earnings Detail",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description:
      "See EPS history, estimate-vs-actual, transcripts and the earnings calendar.",
  },
  {
    key: "aiAssistant",
    label: "AI Research",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description:
      "Ask the AI copilot questions and read AI-generated stock research.",
  },
  {
    key: "tradeTracker",
    label: "Trade Builder & Tracker",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description:
      "Build trades with entry, stop and target and track them over time.",
  },
  {
    key: "portfolio",
    label: "Portfolio Tracking",
    group: "Market Catalyst",
    featureGroup: "marketDesk",
    description: "Track holdings with live prices and profit/loss.",
  },
  {
    key: "themes",
    label: "Sector Themes",
    group: "Stock Intelligence",
    featureGroup: "stockIntelligence",
    description: "Browse curated theme baskets such as Mag7 and AI & Semis.",
  },

  // ── Pro ───────────────────────────────────────────────────────────────────
  {
    key: "moneyFlow",
    label: "Money Flow",
    group: "Money Flow",
    featureGroup: "moneyFlow",
    description: "See where institutional money is moving, by sector.",
  },
  {
    key: "institutionalMovers",
    label: "Institutional Movers",
    group: "Money Flow",
    featureGroup: "moneyFlow",
    description: "See the biggest institutional gainers and losers.",
  },
  {
    key: "optionsChain",
    label: "Options Chain",
    group: "Money Flow",
    featureGroup: "moneyFlow",
    description:
      "View the options chain with strikes, expirations and traded prices.",
    note: "some data simulated",
  },

  // ── Elite ─────────────────────────────────────────────────────────────────
  {
    key: "strategyLab",
    label: "Strategy Lab",
    group: "Strategy Lab",
    featureGroup: "strategyLab",
    description:
      "Build strategies from presets or plain English and get entry, stop and target levels.",
  },
  {
    key: "backtesting",
    label: "Backtesting",
    group: "Strategy Lab",
    featureGroup: "strategyLab",
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
export const CATALOG_VERSION = 3;

/** Plan ids that existed before and must be deactivated on seed. */
export const RETIRED_PLAN_IDS = ["free", "plus"];

function allEntitlements(value: boolean): Record<EntitlementKey, boolean> {
  return Object.fromEntries(ENTITLEMENT_KEYS.map((k) => [k, value]));
}

const NEVER_GRANTED: EntitlementKey[] = ENTITLEMENTS.filter(
  (e) => e.staffOnly || e.unbuilt,
).map((e) => e.key);

// ── Feature groups: the unit plans are sold in ─────────────────────────────

export type FeatureGroupId =
  | "marketDesk"
  | "stockIntelligence"
  | "moneyFlow"
  | "strategyLab";

export interface FeatureGroup {
  id: FeatureGroupId;
  /** User-facing name — always the full name, never an abbreviation. */
  name: string;
  /** One line for plan cards and locked screens. */
  summary: string;
}

/** In ladder order: each plan adds the next group(s). */
export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    id: "marketDesk",
    name: "Market Catalyst",
    summary:
      "Every workspace: dashboard, live feed, movers, heatmap, calendar, IPOs, screener, recaps, earnings, analyst actions, 13F & insider, ETFs, AI companies, portfolio and watchlist.",
  },
  {
    id: "stockIntelligence",
    name: "Stock Intelligence",
    summary:
      "Every stock's page: financials, ratings, peers, dividends, AI research, earnings detail, intraday charts, Trade Builder and Trade Tracker.",
  },
  {
    id: "moneyFlow",
    name: "Money Flow",
    summary:
      "Where institutional money is moving, by sector, with the biggest institutional gainers and losers and the options chain.",
  },
  {
    id: "strategyLab",
    name: "Strategy Lab",
    summary:
      "Build or pick a strategy, backtest it, and get entry, stop and target levels.",
  },
];

/** Plan id → the feature groups it grants (cumulative ladder). */
export const PLAN_GROUPS: Record<string, FeatureGroupId[]> = {
  starter: ["marketDesk", "stockIntelligence"],
  pro: ["marketDesk", "stockIntelligence", "moneyFlow"],
  elite: ["marketDesk", "stockIntelligence", "moneyFlow", "strategyLab"],
};

export function groupOf(key: EntitlementKey): FeatureGroupId | undefined {
  return ENTITLEMENTS.find((e) => e.key === key)?.featureGroup;
}

/** Entitlement keys a set of groups grants (never staff-only or unbuilt rows). */
export function keysForGroups(groups: FeatureGroupId[]): EntitlementKey[] {
  return ENTITLEMENTS.filter(
    (e) =>
      e.featureGroup &&
      groups.includes(e.featureGroup) &&
      !e.staffOnly &&
      !e.unbuilt,
  ).map((e) => e.key);
}

function grants(groups: FeatureGroupId[]): Record<EntitlementKey, boolean> {
  const flags = allEntitlements(false);
  for (const k of keysForGroups(groups)) flags[k] = true;
  for (const k of NEVER_GRANTED) flags[k] = false;
  return flags;
}

const price = (amount: number, lookupKey: string): PlanPrice => ({
  amount,
  lookupKey,
});

/**
 * The plans. There is no free plan: an account without an active paid plan
 * (never paid, cancelled and ended, refunded, or past the past-due grace) has
 * NO_PLAN_ID — sign-in, account settings, Manage Plan, checkout, billing
 * history and legal pages only (PLAN_EXEMPT_ROUTES), and "Choose a plan"
 * everywhere else. The old "free" plan is in RETIRED_PLAN_IDS: apply-catalog
 * marks its Firestore document inactive; it is never deleted.
 */
export const PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    id: "starter",
    name: "Starter",
    amount: 3900,
    currency: "USD",
    billingCycle: "monthly",
    description: "Market Catalyst and Stock Intelligence.",
    featureFlags: grants(PLAN_GROUPS.starter),
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
    description: "Everything in Starter, plus Money Flow.",
    featureFlags: grants(PLAN_GROUPS.pro),
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
    description: "Everything in Pro, plus Strategy Lab.",
    featureFlags: grants(PLAN_GROUPS.elite),
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


/** The effective plan of an account with no active paid plan. Not a plan anyone can buy. */
export const NO_PLAN_ID = "none";

/**
 * Free trial on every plan: card required, $0 today, the first charge when the
 * trial ends. Once per person ever (normalised email, trial_claims/{hash}).
 * 0 turns trials off.
 */
export const TRIAL_DAYS = 7;

/**
 * A new account that hasn't chosen a plan gets INTRO_DAYS of these feature
 * groups (no card), then "Choose a plan". Counted from account creation.
 */
export const INTRO_DAYS = 7;
export const INTRO_GROUPS: FeatureGroupId[] = ["marketDesk"];
export const INTRO_PLAN_ID = "intro";
/** @deprecated There is no default plan any more; kept as an alias of NO_PLAN_ID. */
export const DEFAULT_PLAN_ID = NO_PLAN_ID;

export type SubscriptionStatus =
  | "ACTIVE"
  | "EXPIRED"
  | "CANCELLED"
  | "PAST_DUE"
  | "TRIALING"
  | "NONE"
  /** New-account intro (INTRO_DAYS of INTRO_GROUPS, no card). Never stored in a mirror. */
  | "INTRO";

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

// ── Where each feature lives: backend routes ───────────────────────────────
//
// The ONLY hand-kept list of route → feature. EntitlementGuard (a global
// guard) reads it at request time; route-groups.spec.ts fails when a
// controller route is neither here nor exempt; scripts/export-catalog.ts
// writes the generated feature map from it.
//
// A route lists the feature(s) that use its data; holding ANY of them is
// enough (shared data routes such as /market-data/companies serve several
// screens). "bars" is resolved from the query: intraday ranges need
// chartsIntraday, the 5-year range chartsHistory, the rest chartsDaily.

export type RouteRequirement = EntitlementKey[] | "bars";

export const ROUTE_FEATURES: Record<string, RouteRequirement> = {
  // Market Catalyst
  "GET /api/feature-requests": ["marketCatalyst"],
  "POST /api/feature-requests": ["marketCatalyst"],
  "GET /api/notifications": ["marketCatalyst"],
  "POST /api/notifications/mark-all-read": ["marketCatalyst"],
  "POST /api/stream-ticket": ["marketCatalyst"],
  "GET /live/collections": ["marketCatalyst"],
  "GET /live/market-status": ["marketCatalyst"],
  "GET /live/most-searched-tickers": ["marketCatalyst"],
  "GET /live/ondemand-stats": ["marketCatalyst"],
  "GET /live/snapshot": ["marketCatalyst"],
  "GET /live/stats": ["marketCatalyst"],
  "GET /live/tape": ["marketCatalyst"],
  "GET /live/tape/stats": ["marketCatalyst"],
  "GET /live/what-matters-now": ["marketCatalyst"],
  "GET /market-data/market-sentiment": ["marketCatalyst"],
  "GET /market-data/market-sentiment-history": ["marketCatalyst"],
  "GET /market-data/companies": [
    "marketCatalyst",
    "screener",
    "themes",
    "technicalRatings",
    "chartIndicators",
    "stockIntelligence",
  ],
  "GET /live/quotes": ["marketCatalyst", "stockIntelligence"],
  "GET /live/search": ["marketCatalyst", "stockIntelligence"],
  "POST /live/searched-ticker": ["marketCatalyst", "stockIntelligence"],
  "GET /live/news-wire": ["news"],
  "GET /market-data/news": ["news"],
  "GET /live/news": ["news", "stockIntelligence"],
  "GET /live/scan/biggest-pct": ["scanner"],
  "GET /live/scan/most-active": ["scanner"],
  "GET /market-data/movers": ["scanner"],
  "GET /market-data/volume-leaders": ["scanner"],
  "GET /market-data/sectors": ["heatmap"],
  "GET /market-data/macro-events": ["macro"],
  "GET /market-data/macro-regime": ["macro"],
  "GET /market-data/dividends": ["macro"],
  "GET /market-data/ipos": ["ipos"],
  "GET /market-data/ipo-pipeline": ["ipos"],
  "GET /market-data/recaps": ["recaps"],
  "GET /market-data/earnings": ["earningsHub"],
  "GET /market-data/earnings-announcements": ["earningsHub"],
  "GET /live/earnings-wire": ["earningsHub"],
  "GET /market-data/analyst-actions": ["workspaces"],
  "GET /market-data/analyst-firm-calls": ["workspaces"],
  "GET /market-data/analyst-firm-stats": ["workspaces"],
  "GET /market-data/analyst-history": ["workspaces"],
  "GET /market-data/ai-infrastructure": ["workspaces"],
  "GET /market-data/ai-infrastructure/:theme": ["workspaces"],
  "GET /market-data/etf-holdings": ["workspaces"],
  "GET /market-data/filings-wire": ["workspaces"],
  "GET /market-data/mover-catalysts": ["workspaces"],
  "GET /market-data/mover-catalyst/:ticker": ["workspaces"],
  "GET /live/etf-market": ["workspaces"],
  "GET /live/etfs/market-funds": ["workspaces"],
  "GET /live/filing": ["workspaces"],
  "GET /live/glance/weekly": ["workspaces"],
  "GET /live/glance/monthly": ["workspaces"],
  "GET /live/ticker-announcements": ["workspaces"],
  "GET /market-data/insider-transactions": ["ownership"],
  "GET /market-data/institutional-ownership": ["ownership"],
  "GET /market-data/fund-holdings": ["ownership"],
  "GET /market-data/fund-holdings/positions": ["ownership"],
  "GET /live/ownership": ["ownership"],
  "GET /live/ownership-13dg": ["ownership"],
  "GET /live/13f-filings": ["ownership"],
  "GET /api/portfolio": ["portfolio"],
  "POST /api/portfolio/holdings": ["portfolio"],
  "DELETE /api/portfolio/holdings/:ticker": ["portfolio"],
  "GET /api/portfolio/holdings/:ticker/transactions": ["portfolio"],
  "DELETE /api/portfolio/holdings/:ticker/transactions/:txnId": ["portfolio"],
  "GET /api/watchlist": ["watchlist"],
  "POST /api/watchlist/tickers": ["watchlist"],
  "DELETE /api/watchlist/tickers/:ticker": ["watchlist"],
  "GET /api/watchlists": ["watchlist"],
  "POST /api/watchlists": ["watchlist"],
  "PATCH /api/watchlists/:id": ["watchlist"],
  "DELETE /api/watchlists/:id": ["watchlist"],
  "POST /api/watchlists/:id/tickers": ["watchlist"],
  "DELETE /api/watchlists/:id/tickers/:ticker": ["watchlist"],
  // Stock Intelligence
  "GET /live/company": ["stockIntelligence", "screener"],
  "GET /live/company/summary": ["stockIntelligence"],
  "GET /live/splits": ["stockIntelligence"],
  "GET /live/bars": "bars",
  "GET /live/financials": ["fundamentalRatings"],
  "GET /live/peers-summary": ["peers"],
  "GET /live/dividend-history": ["dividendHistory"],
  "GET /live/estimates": ["earningsDetail"],
  "GET /live/earnings-transcript": ["earningsDetail"],
  "GET /live/earnings-transcript-summary": ["earningsDetail"],
  "GET /live/ai-analysis": ["aiAssistant"],
  "GET /live/ticker-analysis": ["aiAssistant"],
  "POST /live/copilot": ["aiAssistant"],
  "GET /api/ai/portfolio": ["aiAssistant"],
  "GET /api/ai/watchlist": ["aiAssistant"],
  "GET /api/stock-notes": ["chartNotes"],
  "GET /api/stock-notes/all": ["chartNotes"],
  "POST /api/stock-notes": ["chartNotes"],
  "DELETE /api/stock-notes/:id": ["chartNotes"],
  // Money Flow
  "GET /live/money-flow": ["moneyFlow", "institutionalMovers"],
  "GET /live/options-chain": ["optionsChain"],
  // Strategy Lab
  "GET /live/strategy-lab/universe": ["strategyLab"],
  "POST /live/strategy-lab/validate": ["strategyLab"],
  "POST /live/strategy-lab/ai-rules": ["strategyLab"],
  "GET /live/strategy-lab/saved": ["strategyLab"],
  "POST /live/strategy-lab/saved/:id": ["strategyLab"],
  "DELETE /live/strategy-lab/saved/:id": ["strategyLab"],
  "GET /live/strategy-lab/bars": ["backtesting"],
};

/**
 * Routes an account WITHOUT a plan may use: sign-in and account settings,
 * Manage Plan, checkout and billing history, the public catalog, legal and
 * health. Prefix match. Admin-guarded and @Public routes are exempt anyway.
 */
export const PLAN_EXEMPT_ROUTES: Array<{ prefix: string; reason: string }> = [
  { prefix: "/api/account", reason: "sign-in, email verification, claims" },
  { prefix: "/api/session", reason: "sign-in session" },
  { prefix: "/api/whoami-user", reason: "sign-in identity" },
  { prefix: "/api/profile", reason: "account settings" },
  { prefix: "/api/settings", reason: "account settings" },
  { prefix: "/api/billing", reason: "Manage Plan, checkout, billing history" },
  { prefix: "/api/me", reason: "entitlements (drives Choose a plan)" },
  { prefix: "/plans", reason: "the public plan catalog" },
  { prefix: "/health", reason: "health check" },
  { prefix: "/public", reason: "website landing data" },
  { prefix: "/mcp", reason: "admin-issued API keys (McpApiKeyGuard)" },
  { prefix: "/live/stream", reason: "needs a stream ticket, issued only on a plan" },
  { prefix: "/live/tape/stream", reason: "needs a stream ticket, issued only on a plan" },
];

/** Intraday ranges served by /live/bars (minute bars). */
export const INTRADAY_TFS = new Set(["1H", "1D", "5D", "1W", "1M"]);

/** The entitlement keys a request to `routeKey` needs (any of them), or null if exempt/unknown. */
export function routeRequirement(
  routeKey: string,
  query: Record<string, unknown> = {},
): EntitlementKey[] | null {
  const r = ROUTE_FEATURES[routeKey];
  if (!r) return null;
  if (r !== "bars") return r;
  if (query.interval != null) return ["chartsIntraday"];
  const tf = String(query.tf ?? "")
    .toUpperCase()
    .trim();
  if (INTRADAY_TFS.has(tf)) return ["chartsIntraday"];
  if (tf === "5Y") return ["chartsHistory"];
  return ["chartsDaily"];
}

export function isPlanExempt(path: string): boolean {
  return PLAN_EXEMPT_ROUTES.some(
    (e) => path === e.prefix || path.startsWith(e.prefix + "/"),
  );
}

// ── Where each feature lives: UI screens and widgets ───────────────────────

/** UI screen slug (app/dashboard/menu-items.ts and top-level routes) → feature. */
export const SCREEN_FEATURES: Record<string, EntitlementKey> = {
  dashboard: "marketCatalyst",
  commentary: "news",
  movers: "scanner",
  heatmap: "heatmap",
  macro: "macro",
  ipos: "ipos",
  screener: "screener",
  recap: "recaps",
  "weekly-recap": "recaps",
  earnings: "earningsHub",
  analyst: "workspaces",
  insider: "ownership",
  "etf-corner": "workspaces",
  "ai-infrastructure": "workspaces",
  filing: "workspaces",
  portfolio: "portfolio",
  watchlist: "watchlist",
  requests: "marketCatalyst",
  themes: "themes",
  notes: "chartNotes",
  stock: "stockIntelligence",
  si: "stockIntelligence",
  "money-flow": "moneyFlow",
  options: "optionsChain",
  sl: "strategyLab",
};

/** Screens an account without a plan can open (everything else: "Choose a plan"). */
export const PLAN_EXEMPT_SCREENS = [
  "auth",
  "verify-email",
  "settings",
  "profile",
  "manage-plan",
  "checkout",
  "billing",
  "legal",
  "version",
] as const;

/** Widgets inside a screen that are gated on their own (they make no call when locked). */
export const WIDGET_FEATURES: Record<string, EntitlementKey> = {
  "dashboard.analyst": "workspaces",
  "dashboard.portfolio": "portfolio",
  "dashboard.insider": "ownership",
  "commentary.portfolio": "portfolio",
  "stock.aiResearch": "aiAssistant",
  "stock.financials": "fundamentalRatings",
  "stock.tradeBuilder": "tradeTracker",
};

// ── Where each feature lives: Firestore client reads ───────────────────────

/**
 * Collections no browser reads (every screen goes through the backend, which
 * uses the Admin SDK). Their old plan gates were dead; they now deny client
 * reads outright. Written into firestore.rules' generated section.
 */
export const CLIENT_DENIED_COLLECTIONS = [
  "earnings_summaries",
  "options_flow",
  "block_trades",
  "fund_holdings",
  "story_stocks",
] as const;

// ── Plan-card copy (website tiles, signup and Manage Plan cards) ───────────

export const PLAN_CARD_BULLETS: Record<string, string[]> = {
  starter: [
    "Market Catalyst: all workspaces",
    "Stock Intelligence and AI research",
    "Trade Builder and Trade Tracker",
  ],
  pro: [
    "Everything in Starter",
    "Money Flow by sector",
    "Biggest institutional gainers and losers",
  ],
  elite: [
    "Everything in Pro",
    "Strategy Lab",
    "Backtest any strategy",
    "Strategy Lab entry, stop and target levels",
  ],
};

/** What all three plans share — the "Every plan includes" list. */
export const EVERY_PLAN_INCLUDES = [
  "Market Catalyst — every workspace: dashboard, live feed, movers, heatmap, calendar, IPOs, screener, recaps, Earnings Hub, analyst actions, 13F & insider, ETF Corner and AI Companies",
  "Stock Intelligence — any stock's financials, ratings, peers, dividends, earnings detail and transcripts, AI research, and intraday and five-year charts with indicators",
  "Portfolio — track holdings with live prices and profit/loss",
  "Watchlist — unlimited tickers",
];
