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
  /** No implementation exists yet; shown as "coming soon", never as a paywall. */
  unbuilt?: boolean;
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
  // ── Core market data ──────────────────────────────────────────────────────
  { key: 'marketCatalyst', label: 'Market Dashboard', group: 'Core',
    description: 'See the main dashboard with market pulse, movers and heatmap.' },
  { key: 'news', label: 'News & Commentary', group: 'Core',
    description: 'Read the live news feed and commentary screen.' },
  { key: 'scanner', label: 'Market Movers', group: 'Core',
    description: 'See daily gainers, losers and unusual-volume lists.' },
  { key: 'heatmap', label: 'Sector Heatmap', group: 'Core',
    description: 'View the sector and stock heatmap with day/week performance.' },
  { key: 'macro', label: 'Macro & Calendars', group: 'Core',
    description: 'Access the economic calendar, VIX and dividend calendars.' },
  { key: 'ipos', label: 'IPO Corner', group: 'Core',
    description: 'Browse upcoming and recent IPOs with offer prices.' },

  // ── Charting ──────────────────────────────────────────────────────────────
  { key: 'chartsDaily', label: 'Daily Charts', group: 'Charting',
    description: 'View 3-month, 6-month and 1-year price charts.' },
  { key: 'chartsIntraday', label: 'Intraday Charts', group: 'Charting',
    description: 'View 1-day, 1-week and 1-month charts built from minute bars.' },
  { key: 'chartsHistory', label: 'Long History (5Y)', group: 'Charting',
    description: 'View the full five-year price history on any chart.' },
  { key: 'chartIndicators', label: 'Chart Indicators', group: 'Charting',
    description: 'Overlay moving averages, EMAs, volume and the RSI pane.' },
  { key: 'chartNotes', label: 'Chart Notes', group: 'Charting',
    description: 'Save personal notes pinned to a chart.' },

  // ── Research depth ────────────────────────────────────────────────────────
  { key: 'technicalRatings', label: 'Technical Ratings', group: 'Research',
    description: 'See the technical rating gauge, RSI, MACD and moving-average table.' },
  { key: 'fundamentalRatings', label: 'Financial Statements', group: 'Research',
    description: 'See quarterly revenue, EPS, balance sheet and cash flow.' },
  { key: 'dividendHistory', label: 'Dividend History', group: 'Research',
    description: 'See full dividend history, yield, growth rate and payment dates.' },
  { key: 'peers', label: 'Peer Comparison', group: 'Research',
    description: 'See comparable companies and how the stock ranks against them.' },
  { key: 'ownership', label: 'Insider & 13F', group: 'Research',
    description: 'See insider trades and institutional fund holdings.' },
  { key: 'earningsDetail', label: 'Earnings Detail', group: 'Research',
    description: 'See EPS history, estimate-vs-actual and the earnings calendar.' },

  // ── Personal tools ────────────────────────────────────────────────────────
  { key: 'watchlist', label: 'Watchlist', group: 'My Money',
    description: 'Build and track a personal watchlist of stocks.' },
  { key: 'portfolio', label: 'Portfolio Tracking', group: 'My Money',
    description: 'Track holdings with live prices and profit/loss.' },
  { key: 'screener', label: 'Stock Screener', group: 'My Money',
    description: 'Filter the universe by growth, technical and liquidity criteria.' },
  { key: 'themes', label: 'Sector Themes', group: 'My Money',
    description: 'Browse curated theme baskets such as Mag7 and AI & Semis.' },
  { key: 'alerts', label: 'Price Alerts', group: 'My Money',
    description: 'Create alerts that fire when a price or signal condition is met.',
    unbuilt: true },

  // ── Advanced / premium ────────────────────────────────────────────────────
  { key: 'optionsChain', label: 'Options Chain', group: 'Advanced',
    description: 'View the options chain with strikes, expirations and traded prices.' },
  { key: 'exportData', label: 'Data Export', group: 'Advanced',
    description: 'Download screens and recaps as PDF or CSV.', unbuilt: true },
  { key: 'apiAccess', label: 'API Access', group: 'Advanced',
    description: 'Call the market-data API from your own scripts with a key.',
    unbuilt: true },
  { key: 'aiAssistant', label: 'AI Assistant', group: 'Advanced',
    description: 'Ask the AI copilot questions and get generated summaries.',
    unbuilt: true },
  { key: 'backtesting', label: 'Backtesting', group: 'Advanced',
    description: 'Test a strategy against historical price data.', unbuilt: true },
  { key: 'paperTrading', label: 'Paper Trading', group: 'Advanced',
    description: 'Place simulated trades without real money.', unbuilt: true },

  // ── Staff only ────────────────────────────────────────────────────────────
  { key: 'adminDashboard', label: 'Admin Console', group: 'Staff',
    description: 'Open the admin console with revenue and user analytics.',
    staffOnly: true },
  { key: 'userManagement', label: 'User Management', group: 'Staff',
    description: 'View and manage other users’ accounts and subscriptions.',
    staffOnly: true },
];

export const ENTITLEMENT_KEYS = ENTITLEMENTS.map((e) => e.key) as unknown as readonly string[];

export type EntitlementKey = string;

export type BillingCycle = 'monthly' | 'yearly' | 'none';

export interface PlanDefinition {
  id: string;
  name: string;
  /**
   * Minor units (cents for USD), matching Stripe's convention. Storing 4999
   * rather than 49.99 avoids float rounding on every revenue sum, and is what
   * Stripe will charge. Format as major units (÷100) only at display time.
   */
  amount: number;
  currency: string;
  billingCycle: BillingCycle;
  description: string;
  featureFlags: Record<EntitlementKey, boolean>;
  active: boolean;
  /** Display order in pricing tables; lower first. */
  sortOrder: number;
  /** Populated once Stripe products exist; null keeps the plan non-purchasable. */
  stripePriceId: string | null;
}

/** Every entitlement set to the same value — the requirement's starting point. */
function allEntitlements(value: boolean): Record<EntitlementKey, boolean> {
  return Object.fromEntries(ENTITLEMENT_KEYS.map((k) => [k, value])) as Record<
    EntitlementKey,
    boolean
  >;
}

/**
 * Staff capabilities. Forced false on EVERY plan: they are not purchasable, and
 * granting them to a paying customer would be privilege escalation rather than
 * an upsell. Access is gated on the admin account instead.
 */
const STAFF_ONLY: EntitlementKey[] = ENTITLEMENTS.filter((e) => e.staffOnly).map(
  (e) => e.key,
);

/**
 * The tier ladder — what each plan actually includes.
 *
 * Cumulative by design: every tier grants everything below it plus its own
 * additions, so a customer upgrading never loses a feature they were using.
 * That property is easy to break by hand-editing three independent lists, which
 * is why the sets below are composed rather than written out separately.
 *
 * The requirement's starting point was "every feature on every plan", which
 * shipped the plumbing but left the three tiers byte-identical — the admin
 * console showed the same 14 toggles whichever plan was selected, because the
 * underlying documents genuinely were the same. This is the real packaging.
 */
/** Free: browse the market and keep a watchlist. Daily charts only. */
const FREE_GRANTS: EntitlementKey[] = [
  'marketCatalyst',
  'news',
  'scanner',
  'heatmap',
  'macro',
  'ipos',
  'chartsDaily',
  'watchlist',
];

/** Plus: the working toolkit — real charting, research depth, personal tools. */
const PLUS_ADDS: EntitlementKey[] = [
  'chartsIntraday',
  'chartsHistory',
  'chartIndicators',
  'chartNotes',
  'technicalRatings',
  'dividendHistory',
  'peers',
  'earningsDetail',
  'portfolio',
  'screener',
  'themes',
  'alerts',
];

/** Pro: everything customer-facing, including the not-yet-built premium tier. */
const PRO_ADDS: EntitlementKey[] = [
  'fundamentalRatings',
  'ownership',
  'optionsChain',
  'exportData',
  'apiAccess',
  'aiAssistant',
  'backtesting',
  'paperTrading',
];

/** Builds a flag map granting exactly `granted`, with staff keys forced off. */
function entitlementsFor(granted: EntitlementKey[]): Record<EntitlementKey, boolean> {
  const flags = allEntitlements(false);
  for (const k of granted) flags[k] = true;
  for (const k of STAFF_ONLY) flags[k] = false;
  return flags;
}

const FREE_ENTITLEMENTS = entitlementsFor(FREE_GRANTS);
const PLUS_ENTITLEMENTS = entitlementsFor([...FREE_GRANTS, ...PLUS_ADDS]);
const PRO_ENTITLEMENTS = entitlementsFor([...FREE_GRANTS, ...PLUS_ADDS, ...PRO_ADDS]);

export const PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    id: 'free',
    name: 'Free',
    amount: 0,
    currency: 'USD',
    billingCycle: 'none',
    description: 'Free Plan',
    featureFlags: FREE_ENTITLEMENTS,
    active: true,
    sortOrder: 0,
    stripePriceId: null,
  },
  {
    id: 'plus',
    name: 'Plus',
    amount: 2999, // $29.99
    currency: 'USD',
    billingCycle: 'monthly',
    description: 'Plus Plan',
    featureFlags: PLUS_ENTITLEMENTS,
    active: true,
    sortOrder: 1,
    stripePriceId: null,
  },
  {
    id: 'pro',
    name: 'Pro',
    amount: 4999, // $49.99
    currency: 'USD',
    billingCycle: 'monthly',
    description: 'Professional Plan',
    featureFlags: PRO_ENTITLEMENTS,
    active: true,
    sortOrder: 2,
    stripePriceId: null,
  },
];

/** The plan assigned to a user who has never paid. */
export const DEFAULT_PLAN_ID = 'free';

export type SubscriptionStatus =
  | 'ACTIVE'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'PAST_DUE'
  | 'TRIALING'
  | 'NONE';
