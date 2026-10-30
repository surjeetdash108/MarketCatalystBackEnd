/**
 * THE inventory of which screen calls which backend API — the data behind the
 * admin "API Docs" tab.
 *
 * Why it is code and not a document
 * ---------------------------------
 * This describes the UI (MarketCatalystUI) but lives in the backend, next to
 * job-manifest.ts, for two reasons. It is served only through an AdminGuard
 * endpoint, so none of it ships in the public console.html or any client
 * bundle — this is a map of the internal API surface and must stay admin-only.
 * And it can be checked against the thing it describes: screen-api.registry.spec
 * fails the build when an entry names a route the controllers do not define,
 * when a producer job does not write the collection claimed for it, or when a
 * screen refers to an API that is not catalogued. The same comparison runs at
 * request time against the live route table (screen-api.service.ts), so a
 * deploy that drifts from this file shows up in the tab rather than rotting.
 *
 * Keeping it true
 * ---------------
 * - Added a controller route?   Add it to API_CATALOG, and to the screens that
 *   call it. The spec lists any route the controllers define that is missing.
 * - Added a screen or a call?   Add or edit the screen in SCREENS. A key that
 *   is not in API_CATALOG will not compile.
 * - Added a sync job that fills data an API serves?   List it in `producers`.
 *
 * Plain data on purpose: no Nest decorators, no DI, nothing to mock.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** "GET /live/company" — method and path exactly as Nest registers them. */
export type ApiKey = `${HttpMethod} /${string}`;

/** What "Run checks" should send for an API, or why it must not. */
export type CheckPlan =
  /** Query string to append ("?ticker=AAPL"). Empty means call it as is. */
  | { query?: string }
  /** Reason it is not checked from the browser. */
  | { skip: string };

export interface ApiBody {
  /** What it returns or does, in a sentence. */
  summary: string;
  /** The inputs it takes, in words. */
  params?: string;
  /** Firestore collections or caches the response is built from. */
  store?: readonly string[];
  /**
   * Sync jobs whose failure, or silence, leaves this API serving stale data.
   * Only list the jobs that ARE the data: the status of the API follows them.
   */
  producers?: readonly string[];
  /** Other jobs that write to the same data but whose loss would not stale it. */
  alsoWrittenBy?: readonly string[];
  /** External services called while serving a request. */
  vendors?: readonly string[];
  /** The route is a Server-Sent Events stream (registered as a GET). */
  sse?: boolean;
  /** Only registered on the worker role, not on the public live service. */
  workerOnly?: boolean;
  /**
   * How the tab's "Run checks" exercises it from the admin's browser. Omitted
   * means: a GET with no parameters is called as is; anything else is skipped.
   */
  check?: CheckPlan;
  notes?: string;
}

const ASK_FOR_AAPL = { query: "?ticker=AAPL" } as const;

/**
 * The LLM gateway tries Groq first and falls back to OpenRouter
 * (vendors/llm-gateway.service.ts), so an LLM-backed API lists both, in that order.
 */
const LLM = ["Groq", "OpenRouter"] as const;

export const API_CATALOG = {
  // ── Live: streams, quotes and the tape ─────────────────────────────────────
  "GET /live/tape/stream": {
    summary: "Pushes the ticker-tape frame (index cards, VIX, futures proxies) to every open page.",
    sse: true,
    store: ["tape frame (memory)"],
    vendors: ["FMP", "Polygon"],
    check: { skip: "a Server-Sent Events stream" },
    notes: "Browsers connect straight to the live Cloud Run URL, not through Hosting, because the CDN buffers streams. Falls back to GET /live/tape.",
  },
  "GET /live/tape": {
    summary: "The current tape frame as JSON — the 20 s polling fallback behind the stream.",
    vendors: ["FMP", "Polygon"],
  },
  "GET /live/tape/stats": {
    summary: "Tape service counters (connected viewers, poll state) for diagnostics.",
  },
  "GET /live/stream": {
    summary: "Live price ticks for one ticker, preceded by an opening snapshot.",
    params: "ticker",
    sse: true,
    vendors: ["FMP", "Polygon"],
    check: { skip: "a Server-Sent Events stream" },
  },
  "GET /live/quotes": {
    summary: "Latest price and % change for one or a few tickers (search dropdown, per-ticker fallback).",
    params: "tickers (comma list)",
    vendors: ["FMP", "Polygon"],
    check: { query: "?tickers=AAPL" },
  },
  "GET /live/snapshot": {
    summary: "Quotes for every ticker on screen in one call, refreshed app-wide every 30 s.",
    params: "tickers (comma list, up to 250 per call)",
    vendors: ["FMP", "Polygon"],
    check: { query: "?tickers=AAPL,MSFT" },
    notes: "The snapshot cache re-fetches tickers someone is watching every 10 s in market hours.",
  },
  "GET /live/market-status": {
    summary: "Market session phase (pre / regular / post / closed), its label, and upcoming market holidays.",
    vendors: ["FMP", "Polygon"],
  },
  "GET /live/stats": {
    summary: "Snapshot cache counters (hits, coalesced fetches) for diagnostics.",
  },
  "GET /live/collections": {
    summary: "Raw read of named shared collections from the server-side cache; no screen calls it.",
    params: "names (comma list of cacheable collections)",
    check: { skip: "needs a list of collection names" },
  },

  // ── Live: feeds ────────────────────────────────────────────────────────────
  "GET /live/news-wire": {
    summary: "Incremental news feed: only the items newer than the cursor the previous call returned.",
    params: "since (cursor from the last response)",
    vendors: ["Polygon", "FMP"],
  },
  "GET /live/earnings-wire": {
    summary: "Fresh earnings results shaped as news items for the Live Feed.",
    store: ["earnings_events"],
    producers: ["earnings-actuals", "earnings"],
  },
  "GET /live/money-flow": {
    summary: "Money Flow board: flows, movers, levels and scores built server-side from Polygon bars and FMP quotes; cached 30s.",
    vendors: ["Polygon", "FMP"],
  },
  "GET /live/what-matters-now": {
    summary: "AI-written market digest, cached an hour; the first viewer after expiry triggers generation.",
    vendors: LLM,
    check: { skip: "can start an LLM generation" },
  },
  "GET /live/ticker-analysis": {
    summary: "Stored AI analysis for one ticker (summary, sentiment, factors, risks). Read-only: never generates.",
    params: "ticker",
    store: ["ticker_ai_analysis"],
    check: ASK_FOR_AAPL,
  },
  "GET /live/ticker-announcements": {
    summary: "Recent AI-analysed announcements (earnings results, 13F) across tickers. Read-only.",
    params: "limit",
    store: ["ticker_ai_analysis"],
    producers: ["earnings-actuals"],
    alsoWrittenBy: ["institutional-ownership", "news"],
    check: { query: "?limit=5" },
  },
  "GET /live/scan/biggest-pct": {
    summary: "Biggest % gainers and losers grouped by sector, built from the companies universe and recomputed after 2 h.",
    store: ["companies"],
  },
  "GET /live/scan/most-active": {
    summary: "Most active stocks by volume and relative volume, grouped by sector; recomputed after 1 h.",
    store: ["companies"],
  },
  "GET /live/glance/weekly": {
    summary: "'Week at a glance' market digests, newest first; the current week is built on demand if older than 12 h.",
    store: ["market_weekly_glance"],
    alsoWrittenBy: ["market-glance-weekly"],
    vendors: LLM,
    check: { skip: "can start an LLM generation" },
  },
  "GET /live/glance/monthly": {
    summary: "'Month at a glance' digests; the current month is built on demand if older than 24 h.",
    store: ["market_monthly_glance"],
    vendors: LLM,
    check: { skip: "can start an LLM generation" },
  },

  // ── Live: per-ticker ───────────────────────────────────────────────────────
  "GET /live/ai-analysis": {
    summary: "On-demand AI read of a ticker (headline, volatility, momentum, news and technical summaries).",
    params: "ticker",
    store: ["ticker_ai_analysis"],
    vendors: LLM,
    check: { skip: "can start an LLM generation" },
    notes: "A slow model outlives the browser's 20 s timeout, so the page re-polls every 30 s while the backend finishes.",
  },
  "POST /live/copilot": {
    summary: "Chat reply for the Stock Intelligence 'Ask AI' box.",
    params: "body: ticker, query, context",
    vendors: LLM,
  },
  "GET /live/bars": {
    summary: "OHLCV bars for a ticker by timeframe (tf) or interval; fetches only the days missing from stored history.",
    params: "ticker, and either tf or interval",
    store: ["ohlcv_bars"],
    alsoWrittenBy: ["stock-history", "history-backfill"],
    vendors: ["FMP", "Polygon"],
    check: { query: "?ticker=AAPL&tf=1M" },
  },
  "GET /live/company": {
    summary: "Full company document (price, fundamentals, technicals, ratings), rebuilt from vendors when missing or stale.",
    params: "ticker",
    store: ["companies"],
    alsoWrittenBy: ["company-quotes", "companies", "technical-indicators", "rs-rating", "tech-rating", "fundamentals-growth", "beta"],
    vendors: ["FMP", "Polygon"],
    check: ASK_FOR_AAPL,
  },
  "GET /live/company/summary": {
    summary: "Fast key stats for a ticker whose company document is not stored yet (marked partial).",
    params: "ticker",
    vendors: ["FMP", "Polygon"],
    check: ASK_FOR_AAPL,
  },
  "GET /live/estimates": {
    summary: "Quarterly analyst EPS and revenue estimates for a ticker.",
    params: "ticker",
    vendors: ["FMP"],
    check: ASK_FOR_AAPL,
  },
  "GET /live/peers-summary": {
    summary: "Compact peer table: name, market cap, P/E, RS rating, weekly and monthly change.",
    params: "tickers (comma list)",
    check: { query: "?tickers=MSFT,GOOGL" },
  },
  "GET /live/logo": {
    summary: "Company logo image proxied from Polygon branding so the key stays server-side; 204 when there is none.",
    params: "ticker",
    vendors: ["Polygon"],
    check: { skip: "returns an image, not JSON" },
    notes: "Deliberately unauthenticated: it is loaded as an <img src>, which cannot carry an Authorization header.",
  },
  "GET /live/dividend-history": {
    summary: "Dividend history, annual totals, TTM yield, 5-year CAGR and increase streak for a ticker.",
    params: "ticker",
    store: ["dividend_history"],
    alsoWrittenBy: ["corporate-actions"],
    vendors: ["FMP", "Polygon"],
    check: ASK_FOR_AAPL,
  },
  "GET /live/splits": {
    summary: "Stock-split history for a ticker.",
    params: "ticker",
    store: ["splits"],
    alsoWrittenBy: ["corporate-actions"],
    vendors: ["FMP", "Polygon"],
    check: ASK_FOR_AAPL,
  },
  "GET /live/ownership": {
    summary: "Institutional ownership rollup and top 13F holders (FMP) plus FINRA short interest (Polygon).",
    params: "ticker",
    vendors: ["FMP", "Polygon"],
    check: ASK_FOR_AAPL,
  },
  "GET /live/financials": {
    summary: "Quarterly and annual financials with reported EPS against estimate, for a ticker.",
    params: "ticker",
    store: ["financials"],
    alsoWrittenBy: ["financials"],
    vendors: ["FMP", "Polygon"],
    check: ASK_FOR_AAPL,
  },
  "GET /live/ownership-13dg": {
    summary: "Named >5% beneficial owners from SEC Schedules 13D/G.",
    params: "ticker",
    vendors: ["SEC EDGAR"],
    check: { skip: "a cold request walks up to two dozen SEC filing pages" },
  },
  "GET /live/13f-filings": {
    summary: "Quarterly 13F institutional holders for a ticker, optionally for a chosen year and quarter.",
    params: "ticker, year?, quarter?",
    vendors: ["SEC EDGAR"],
    check: ASK_FOR_AAPL,
  },
  "GET /live/filing": {
    summary: "A SEC filing's HTML for the sandboxed viewer; a filing is immutable so it is cached a day.",
    params: "cik, accession",
    vendors: ["SEC EDGAR"],
    check: { skip: "needs a real filing's cik and accession" },
  },
  "GET /live/news": {
    summary: "Recent news for one ticker (Polygon and FMP merged and de-duplicated).",
    params: "ticker",
    vendors: ["Polygon", "FMP"],
    check: ASK_FOR_AAPL,
  },
  "GET /live/earnings-transcript": {
    summary: "Latest earnings-call transcript for a ticker.",
    params: "ticker",
    vendors: ["FMP"],
    check: { skip: "returns a full transcript" },
  },
  "GET /live/earnings-transcript-summary": {
    summary: "AI key takeaways from the latest earnings-call transcript.",
    params: "ticker",
    vendors: ["FMP", ...LLM],
    check: { skip: "can start an LLM generation" },
  },
  "GET /live/options-chain": {
    summary: "Options contracts for a ticker in the supported options universe.",
    params: "ticker",
    store: ["options_chains"],
    alsoWrittenBy: ["options-chains"],
    vendors: ["Polygon"],
    check: { skip: "options data is slow and rate-limited" },
  },
  "GET /live/search": {
    summary: "Ticker search over the ~10,000 active US tickers by symbol or name.",
    params: "q",
    store: ["ticker universe (memory, reloaded daily)"],
    vendors: ["Polygon"],
    check: { query: "?q=apple" },
  },
  "POST /live/searched-ticker": {
    summary: "Records that a ticker was searched, feeding Most Searched; typos are ignored.",
    params: "body: ticker",
  },
  "GET /live/most-searched-tickers": {
    summary: "The most-searched tickers with counts.",
    params: "limit",
    check: { query: "?limit=5" },
  },
  "GET /live/ondemand-stats": {
    summary: "Cache and request-coalescing counters of the on-demand layer, for diagnostics.",
  },
  "GET /live/etf-market": {
    summary: "ETFs discovered and classified into 10 categories, with price, change, volume and AUM.",
    store: ["etf_market_current", "etf_market_previous"],
    producers: ["etf-market"],
    vendors: ["FMP", "Polygon"],
  },
  "GET /live/etfs/market-funds": {
    summary: "Alias of GET /live/etf-market.",
    store: ["etf_market_current", "etf_market_previous"],
    producers: ["etf-market"],
  },

  // ── Live: Strategy Lab ─────────────────────────────────────────────────────
  "GET /live/strategy-lab/bars": {
    summary: "Price bars for the Strategy Lab (daily or intraday packs).",
    params: "symbols, tf, and days or years",
    store: ["lab_bars", "lab_ibars"],
    producers: ["strategy-lab-daily", "strategy-lab-intraday"],
    vendors: ["FMP"],
    check: { query: "?symbols=AAPL&tf=d&years=1" },
  },
  "POST /live/strategy-lab/validate": {
    summary: "Backtests an entry/exit rule spec against the stored price packs and the jobs' precomputed results.",
    params: "body: spec, tf, cfg",
    store: ["lab_results", "lab_meta"],
    producers: ["strategy-lab-daily", "strategy-lab-intraday"],
  },
  "POST /live/strategy-lab/ai-rules": {
    summary: "Turns plain-English strategy text into entry and exit rules with an LLM.",
    params: "body: q",
    vendors: LLM,
  },

  // ── Market data: shared lists filled by sync jobs ──────────────────────────
  "GET /market-data/companies": {
    summary: "The synced company universe (price, % change, market cap, sector, ratings, technicals) behind the heatmap, screener, movers and search.",
    store: ["companies"],
    producers: ["company-quotes"],
    alsoWrittenBy: ["companies", "ticker-universe", "technical-indicators", "rs-rating", "tech-rating", "fundamentals-growth", "beta", "news"],
  },
  "GET /market-data/sectors": {
    summary: "Sector performance (% change by sector) for leaders, laggards and the heatmap.",
    store: ["sectors"],
    producers: ["sectors"],
  },
  "GET /market-data/earnings": {
    summary: "Earnings calendar: date, session, EPS and revenue estimate and actual.",
    store: ["earnings_events"],
    producers: ["earnings", "earnings-actuals"],
  },
  "GET /market-data/earnings-announcements": {
    summary: "8-K earnings announcements with session, price reaction and guidance direction.",
    store: ["earnings_announcements"],
    producers: ["edgar-8k"],
  },
  "GET /market-data/news": {
    summary: "Market news feed (Polygon and FMP merged), newest first.",
    store: ["news"],
    producers: ["news"],
  },
  "GET /market-data/movers": {
    summary: "Top gainers and losers with price, volume, relative volume and sector.",
    store: ["market_movers", "companies"],
    producers: ["market-movers"],
  },
  "GET /market-data/volume-leaders": {
    summary: "The whole US market ranked by relative volume.",
    store: ["volume_leaders"],
    producers: ["volume-leaders"],
  },
  "GET /market-data/insider-transactions": {
    summary: "Insider (Form 4) transactions, market-wide or for one ticker.",
    params: "ticker?, limit?",
    store: ["insider_transactions"],
    producers: ["sec-form4"],
    check: { query: "?limit=20" },
  },
  "GET /market-data/institutional-ownership": {
    summary: "Per-ticker institutional ownership rollups from 13F filings.",
    store: ["institutional_ownership"],
    producers: ["institutional-ownership"],
  },
  "GET /market-data/fund-holdings": {
    summary: "The tracked funds and their latest 13F filings.",
    store: ["fund_holdings"],
    producers: ["sec-13f"],
  },
  "GET /market-data/fund-holdings/positions": {
    summary: "The 25 largest positions of one tracked fund's filing.",
    params: "cik, accession",
    store: ["fund_holdings/{cik}/filings/{accession}/positions"],
    producers: ["sec-13f"],
    check: { skip: "needs a tracked fund's cik and a real accession" },
  },
  "GET /market-data/etf-holdings": {
    summary: "Holdings, sector weights, AUM and expense ratio for an ETF.",
    params: "symbol",
    store: ["etf_holdings"],
    alsoWrittenBy: ["etf-holdings"],
    check: { query: "?symbol=SPY" },
    notes: "Unauthenticated. The etf-holdings job refreshes 16 popular ETFs daily; any other ETF is built on demand when its stored copy is over 7 days old.",
  },
  "GET /market-data/analyst-actions": {
    summary: "Analyst consensus per ticker: vote counts, price-target figures and recent grades.",
    params: "ticker?",
    store: ["analyst_actions"],
    producers: ["analyst-actions"],
  },
  "GET /market-data/analyst-firm-stats": {
    summary: "Measured track record per analyst firm (hit rate, average move after a call).",
    store: ["analyst_firm_stats"],
    producers: ["analyst-firm-stats"],
  },
  "GET /market-data/analyst-history": {
    summary: "Every rating change on record for one stock, newest first.",
    params: "ticker",
    vendors: ["FMP"],
    check: ASK_FOR_AAPL,
  },
  "GET /market-data/analyst-firm-calls": {
    summary: "Every stored call by one analyst firm, with its outcome, newest first.",
    params: "firm",
    store: ["analyst_calls"],
    producers: ["analyst-firm-stats"],
    check: { skip: "needs a real firm name" },
  },
  "GET /market-data/market-sentiment": {
    summary: "The Fear & Greed index: value, label, components and intraday readings.",
    store: ["market_sentiment"],
    producers: ["fear-greed"],
  },
  "GET /market-data/market-sentiment-history": {
    summary: "Fear & Greed history by date.",
    store: ["market_sentiment_history"],
    producers: ["fear-greed"],
  },
  "GET /market-data/recaps": {
    summary: "Daily and weekly market recaps: internals, indices, top movers, sector leaders, narrative.",
    store: ["recaps"],
    producers: ["recaps"],
  },
  "GET /market-data/macro-events": {
    summary: "Economic calendar: event, importance, date, actual, previous and estimate.",
    store: ["macro_events"],
    producers: ["macro-events"],
  },
  "GET /market-data/macro-regime": {
    summary: "The FRED-derived macro regime label; no screen calls it.",
    store: ["macro_regime"],
    producers: ["macro-regime"],
  },
  "GET /market-data/ipos": {
    summary: "Upcoming and recent IPOs.",
    store: ["ipos"],
    producers: ["ipos"],
  },
  "GET /market-data/ipo-pipeline": {
    summary: "SEC S-1 / 424B registrations in the IPO pipeline.",
    store: ["ipo_pipeline"],
    producers: ["edgar-ipo-pipeline"],
  },
  "GET /market-data/dividends": {
    summary: "The dividend calendar; no screen calls it.",
    store: ["dividends"],
    producers: ["dividends"],
  },
  "GET /market-data/filings-wire": {
    summary: "Recent SEC 8-K filings as a wire; no screen calls it.",
    store: ["filings_wire"],
    producers: ["edgar-8k"],
  },
  "GET /market-data/mover-catalysts": {
    summary: "Why-it's-moving explanations for several tickers in one call; no screen calls it.",
    params: "tickers (comma list)",
    store: ["mover_catalysts"],
    check: { skip: "can start LLM generations" },
  },
  "GET /market-data/mover-catalyst/:ticker": {
    summary: "A short explanation of why one ticker is moving, generated on demand and cached.",
    params: "path: ticker; query: direction?, pctChange?",
    store: ["mover_catalysts"],
    vendors: LLM,
    check: { skip: "can start an LLM generation" },
  },
  "GET /market-data/ai-infrastructure": {
    summary: "AI-infrastructure investment themes with company counts and sample tickers.",
    store: ["companies"],
  },
  "GET /market-data/ai-infrastructure/:theme": {
    summary: "The companies in one AI-infrastructure theme.",
    params: "path: theme key",
    store: ["companies"],
    check: { skip: "needs a theme key" },
  },

  // ── Signed-in user data ────────────────────────────────────────────────────
  "GET /api/profile": {
    summary: "The signed-in user's profile document (tier, investor profile).",
    store: ["per-user Firestore documents"],
  },
  "PATCH /api/profile": {
    summary: "Creates or updates the signed-in user's profile (sign-up, first Google login, profile edit).",
    params: "body: profile fields",
  },
  "GET /api/settings": {
    summary: "The user's settings (dark mode, font, alert preferences).",
    store: ["per-user Firestore documents"],
  },
  "PATCH /api/settings": {
    summary: "Updates one or more settings.",
    params: "body: darkMode?, font?, alert?",
  },
  "GET /api/whoami-user": {
    summary: "Echoes the verified identity of the caller; diagnostic, no screen calls it.",
  },
  "POST /api/session/claim": {
    summary: "Called after each login: this device becomes the user's only valid session, signing out the others.",
    params: "body: sessionId",
    notes: "Added after the Oct 24 audit; every authenticated call then carries X-Session-Id and is refused if it is not the claimed one.",
  },
  "GET /api/watchlists": {
    summary: "All the user's watchlists with their tickers, and the plan's ticker limit.",
    store: ["per-user Firestore documents"],
  },
  "POST /api/watchlists": {
    summary: "Creates a watchlist.",
    params: "body: name",
  },
  "PATCH /api/watchlists/:id": {
    summary: "Renames a watchlist.",
    params: "body: name",
  },
  "DELETE /api/watchlists/:id": {
    summary: "Deletes a watchlist (the server recreates 'My Watchlist' if it was the last).",
  },
  "POST /api/watchlists/:id/tickers": {
    summary: "Adds a ticker to a watchlist, subject to the plan's limit.",
    params: "body: ticker",
  },
  "DELETE /api/watchlists/:id/tickers/:ticker": {
    summary: "Removes a ticker from a watchlist.",
  },
  "GET /api/watchlist": {
    summary: "The legacy single watchlist (tickers only).",
  },
  "POST /api/watchlist/tickers": {
    summary: "Legacy: adds a ticker to the single watchlist; no screen calls it.",
    params: "body: ticker",
  },
  "DELETE /api/watchlist/tickers/:ticker": {
    summary: "Legacy: removes a ticker from the single watchlist; no screen calls it.",
  },
  "GET /api/portfolio": {
    summary: "The user's holdings: shares, cost basis, realised P/L, conviction.",
    store: ["per-user Firestore documents"],
  },
  "POST /api/portfolio/holdings": {
    summary: "Records a buy or sell.",
    params: "body: ticker, type, shares, price, tradeDate",
  },
  "GET /api/portfolio/holdings/:ticker/transactions": {
    summary: "A holding's transaction history and summary.",
  },
  "DELETE /api/portfolio/holdings/:ticker/transactions/:txnId": {
    summary: "Deletes one transaction and recomputes the holding.",
  },
  "DELETE /api/portfolio/holdings/:ticker": {
    summary: "Removes a holding.",
  },
  "GET /api/ai/portfolio": {
    summary: "AI summary of the user's portfolio (posture, concentration, leaders, laggards).",
    vendors: LLM,
    check: { skip: "can start an LLM generation" },
  },
  "GET /api/ai/watchlist": {
    summary: "AI summary of one of the user's watchlists.",
    params: "listId",
    vendors: LLM,
    check: { skip: "can start an LLM generation" },
  },
  "GET /api/stock-notes": {
    summary: "The user's chart notes for one ticker; no screen calls it.",
    params: "ticker",
    check: { skip: "needs a ticker" },
  },
  "GET /api/stock-notes/all": {
    summary: "All of the user's chart notes, paged.",
    params: "limit, cursor",
    check: { query: "?limit=5" },
  },
  "POST /api/stock-notes": {
    summary: "Saves a chart note on a ticker.",
    params: "body: sym, name, comment",
  },
  "DELETE /api/stock-notes/:id": {
    summary: "Deletes a chart note.",
  },
  "GET /api/feature-requests": {
    summary: "The user's feature requests.",
  },
  "POST /api/feature-requests": {
    summary: "Submits a feature request.",
    params: "body: text",
  },
  "GET /api/notifications": {
    summary: "The user's notifications, newest first, with unread state.",
    alsoWrittenBy: ["news"],
  },
  "POST /api/notifications/mark-all-read": {
    summary: "Marks every notification read.",
  },

  // ── Plans, entitlements, flags ─────────────────────────────────────────────
  "GET /plans": {
    summary: "The plan catalogue: price, billing cycle and entitlement flags.",
    store: ["plans"],
    notes: "Unauthenticated.",
  },
  "POST /plans/seed": {
    summary: "Seeds the default plans (admin).",
  },
  "GET /users/:uid/entitlements": {
    summary: "The resolved entitlements of a user (admin).",
  },
  "GET /feature-flags": {
    summary: "All feature flags (admin).",
  },
  "GET /feature-flags/map": {
    summary: "Feature flags as a key-to-boolean map (admin).",
  },
  "POST /feature-flags/seed": {
    summary: "Seeds the default flags (admin).",
  },
  "POST /feature-flags/:key": {
    summary: "Sets one feature flag (admin).",
  },

  // ── Admin console ──────────────────────────────────────────────────────────
  "GET /api/admin/users": {
    summary: "Every user with plan, status, dates and engagement counts.",
    params: "limit",
  },
  "GET /api/admin/subscriptions": {
    summary: "Payment records, used for lifetime value.",
    params: "limit",
  },
  "GET /api/admin/revenue": {
    summary: "Revenue figures; the console computes its own from users and subscriptions, so it does not call this.",
  },
  "GET /api/admin/feature-adoption": {
    summary: "Opens and distinct users per tracked feature, staff excluded.",
  },
  "PATCH /api/admin/plans/:id": {
    summary: "Sets one entitlement flag on a plan.",
    params: "body: featureFlags {key: boolean}",
  },
  "GET /api/admin/apihealth": {
    summary: "Route inventory of the running service, a probe of the public no-parameter GETs, and vendor reachability.",
  },
  "GET /api/admin/jobs": {
    summary: "Every sync job with its trigger, schedule, next run, last run, health, lease and latest manual run.",
  },
  "GET /api/admin/jobs/runs": {
    summary: "Recent manual runs requested from the Jobs tab, newest first.",
    params: "limit",
    store: ["admin_job_runs"],
  },
  "POST /api/admin/jobs/:name/run": {
    summary: "Starts a job now (a Cloud Run Job execution, or in process on the worker) and records who asked.",
    params: "path: job name; body: confirm?, clearStaleLock?",
    store: ["admin_job_runs", "job_locks"],
  },
  "GET /api/admin/screen-apis": {
    summary: "This catalogue joined with live status: which screen calls which API, and whether it is healthy.",
    params: "fresh?",
  },
  "GET /api/admin/posts": {
    summary: "Blog posts for the console's board.",
  },
  "GET /api/admin/posts/theme": {
    summary: "The shared blog stylesheet; the console does not call it.",
  },
  "POST /api/admin/posts": {
    summary: "Creates a blog post.",
  },
  "PATCH /api/admin/posts/:id": {
    summary: "Edits, publishes or reorders a blog post.",
  },
  "DELETE /api/admin/posts/:id": {
    summary: "Deletes a blog post.",
  },
  "GET /api/admin/media": {
    summary: "The blog image library.",
  },
  "POST /api/admin/media": {
    summary: "Uploads an image to the library.",
  },
  "DELETE /api/admin/media/:id": {
    summary: "Deletes an image from the library.",
  },
  "GET /api/admin/mcp-keys": {
    summary: "MCP server keys (prefix, label, last used, status).",
  },
  "POST /api/admin/mcp-keys": {
    summary: "Generates an MCP key; the raw key is shown once.",
    params: "body: label",
  },
  "POST /api/admin/mcp-keys/:id/revoke": {
    summary: "Revokes an MCP key.",
  },

  // ── Other consumers ────────────────────────────────────────────────────────
  "GET /public/landing-tape": {
    summary: "Four hero figures and the marquee's symbol moves for the marketing landing page.",
    notes: "Unauthenticated. Called server-to-server by the website's /api/market/tape, which caches it 30 s.",
  },
  "POST /mcp": {
    summary: "MCP server: JSON-RPC tool calls for managing blog posts (Bearer MCP key).",
    check: { skip: "needs an MCP key" },
  },
  "GET /mcp": {
    summary: "MCP server: server-to-client stream (Bearer MCP key).",
    sse: true,
  },
  "DELETE /mcp": {
    summary: "MCP server: ends a session (Bearer MCP key).",
  },
  "GET /health": {
    summary: "Liveness probe.",
  },

  // ── Worker only (private; reached through gcloud run services proxy) ───────
  "GET /sync/jobs": {
    summary: "Registered jobs with live run state, as the worker sees them.",
    workerOnly: true,
  },
  "GET /sync/status": {
    summary: "sync_meta for every job.",
    workerOnly: true,
  },
  "GET /sync/:job/status": {
    summary: "sync_meta for one job.",
    workerOnly: true,
  },
  "POST /sync/:job/run": {
    summary: "Runs one job and waits for it; Cloud Scheduler's trigger. A finished run leaves a 30-minute lease that refuses the next run.",
    workerOnly: true,
  },
  "POST /sync/run-all": {
    summary: "Runs every registered job in turn (does not take the lease).",
    workerOnly: true,
  },
  "GET /purge/targets": {
    summary: "Collections the purge tool can clear.",
    workerOnly: true,
  },
  "POST /purge/preview": {
    summary: "Counts what a purge would delete.",
    workerOnly: true,
  },
  "POST /purge/execute": {
    summary: "Deletes documents from a purge target.",
    workerOnly: true,
  },
  "GET /retention/preview": {
    summary: "What the retention prune would delete.",
    workerOnly: true,
  },
  "POST /retention/run": {
    summary: "Prunes old history collections.",
    workerOnly: true,
  },
} as const satisfies Record<ApiKey, ApiBody>;

export type CatalogKey = keyof typeof API_CATALOG;

export type ScreenGroup =
  | "Shared"
  | "Home"
  | "Markets"
  | "Research"
  | "Market Recaps"
  | "My Workspace"
  | "Stock tools"
  | "Account"
  | "Admin"
  | "Other consumers";

/** Display order of the groups in the tab. */
export const SCREEN_GROUPS: readonly ScreenGroup[] = [
  "Shared",
  "Home",
  "Markets",
  "Research",
  "Market Recaps",
  "My Workspace",
  "Stock tools",
  "Account",
  "Admin",
  "Other consumers",
];

export interface ScreenDoc {
  id: string;
  label: string;
  group: ScreenGroup;
  /** What the user opens. */
  route: string;
  /** Entry file, relative to the repository named in `repo`. */
  source: string;
  repo?: "MarketCatalystUI" | "MarketCatalystWebsite" | "MarketCatalystBackEnd";
  summary: string;
  apis: readonly CatalogKey[];
}

/**
 * The ticker chart used by Watchlist, Portfolio, Screener, Themes and Notes
 * (stock-panel.tsx: StockChart and ChartCard), with its earnings dots.
 */
const CHART_PANE = [
  "GET /live/bars",
  "GET /live/news",
  "GET /live/company",
  "GET /live/stream",
  "GET /live/quotes",
  "GET /live/financials",
  "GET /market-data/earnings",
] as const satisfies readonly CatalogKey[];

export const SCREENS = [
  // ── Shared ─────────────────────────────────────────────────────────────────
  {
    id: "shell",
    label: "App shell",
    group: "Shared",
    route: "every signed-in screen",
    source: "app/iq/shell.tsx",
    summary: "The header, left rail, search, notifications and live price plumbing wrapped around every signed-in screen — so these calls happen on all of them.",
    apis: [
      "GET /live/tape/stream",
      "GET /live/tape",
      "GET /live/snapshot",
      "GET /live/market-status",
      "GET /live/search",
      "GET /live/quotes",
      "POST /live/searched-ticker",
      "GET /live/bars",
      "GET /live/logo",
      "GET /market-data/companies",
      "GET /market-data/sectors",
      "GET /market-data/earnings",
      "GET /api/profile",
      "GET /api/settings",
      "PATCH /api/settings",
      "GET /api/watchlists",
      "GET /api/notifications",
      "POST /api/notifications/mark-all-read",
      "POST /api/session/claim",
    ],
  },

  // ── Home ───────────────────────────────────────────────────────────────────
  {
    id: "dashboard",
    label: "Dashboard",
    group: "Home",
    route: "/dashboard",
    source: "app/iq/screens/dashboard.tsx",
    summary: "Indices, What Matters Now, movers, news, Fear & Greed, recaps, the user's watchlist and portfolio.",
    apis: [
      "GET /live/tape/stream",
      "GET /live/tape",
      "GET /live/snapshot",
      "GET /live/what-matters-now",
      "GET /live/news",
      "GET /live/most-searched-tickers",
      "GET /market-data/companies",
      "GET /market-data/sectors",
      "GET /market-data/earnings",
      "GET /market-data/news",
      "GET /market-data/movers",
      "GET /market-data/insider-transactions",
      "GET /market-data/analyst-actions",
      "GET /market-data/market-sentiment",
      "GET /market-data/market-sentiment-history",
      "GET /market-data/earnings-announcements",
      "GET /market-data/recaps",
      "GET /market-data/mover-catalyst/:ticker",
      "GET /api/watchlists",
      "GET /api/portfolio",
    ],
  },
  {
    id: "commentary",
    label: "Live Feed",
    group: "Home",
    route: "/menu/commentary",
    source: "app/iq/screens/commentary.tsx",
    summary: "News wire, earnings announcements, weekly and monthly glance, biggest movers, and a 'my names' tab.",
    apis: [
      "GET /live/snapshot",
      "GET /live/news-wire",
      "GET /live/earnings-wire",
      "GET /live/ticker-analysis",
      "GET /live/ticker-announcements",
      "GET /live/scan/biggest-pct",
      "GET /live/glance/weekly",
      "GET /live/glance/monthly",
      "GET /market-data/news",
      "GET /market-data/companies",
      "GET /api/watchlist",
      "GET /api/portfolio",
    ],
  },

  // ── Markets ────────────────────────────────────────────────────────────────
  {
    id: "money-flow",
    label: "Money Flow",
    group: "Markets",
    route: "/money-flow",
    source: "app/iq/screens/money-flow.tsx",
    summary: "Where money is moving: flow, movers, levels and scores in one board, with a 1-minute bar chart popover.",
    apis: ["GET /live/money-flow", "GET /live/bars"],
  },
  {
    id: "earnings",
    label: "Earnings Hub",
    group: "Markets",
    route: "/menu/earnings",
    source: "app/iq/screens/earnings.tsx",
    summary: "Earnings calendar with announcements, analyst context, financials, and the call transcript with an AI summary.",
    apis: [
      "GET /live/snapshot",
      "GET /live/company",
      "GET /live/financials",
      "GET /live/bars",
      "GET /live/earnings-transcript",
      "GET /live/earnings-transcript-summary",
      "GET /market-data/earnings",
      "GET /market-data/earnings-announcements",
      "GET /market-data/companies",
      "GET /market-data/analyst-actions",
    ],
  },
  {
    id: "movers",
    label: "Movers",
    group: "Markets",
    route: "/menu/movers",
    source: "app/iq/screens/movers.tsx",
    summary: "Top gainers and losers, unusual volume, weekly movers, with a news modal per ticker.",
    apis: [
      "GET /live/snapshot",
      "GET /live/scan/biggest-pct",
      "GET /live/scan/most-active",
      "GET /live/news",
      "GET /market-data/movers",
      "GET /market-data/companies",
      "GET /market-data/volume-leaders",
      "GET /market-data/mover-catalyst/:ticker",
    ],
  },
  {
    id: "heatmap",
    label: "Heatmap",
    group: "Markets",
    route: "/menu/heatmap",
    source: "app/iq/screens/heatmap.tsx",
    summary: "Sector and company heatmap coloured by % change.",
    apis: [
      "GET /live/snapshot",
      "GET /market-data/companies",
      "GET /market-data/sectors",
    ],
  },
  {
    id: "analyst",
    label: "Analyst Actions",
    group: "Markets",
    route: "/menu/analyst",
    source: "app/iq/screens/analyst.tsx",
    summary: "Consensus, firm track records and per-firm call history; refetches at 08:00, 12:00 and 16:00 Central.",
    apis: [
      "GET /live/snapshot",
      "GET /market-data/analyst-actions",
      "GET /market-data/companies",
      "GET /market-data/analyst-firm-stats",
      "GET /market-data/analyst-history",
      "GET /market-data/analyst-firm-calls",
      "GET /api/portfolio",
    ],
  },
  {
    id: "macro",
    label: "Calendar",
    group: "Markets",
    route: "/menu/macro",
    source: "app/iq/screens/macro.tsx",
    summary: "Economic calendar, market holidays and dividend drawers.",
    apis: [
      "GET /live/tape/stream",
      "GET /live/tape",
      "GET /live/market-status",
      "GET /live/dividend-history",
      "GET /market-data/macro-events",
      "GET /market-data/companies",
    ],
  },

  // ── Research ───────────────────────────────────────────────────────────────
  {
    id: "screener",
    label: "Screener & Themes",
    group: "Research",
    route: "/menu/screener",
    source: "app/iq/screens/screener-hub.tsx",
    summary: "Stock screener with presets and a detail pane; /menu/themes opens the same hub on Themes.",
    apis: [
      "GET /market-data/companies",
      "GET /market-data/insider-transactions",
      "GET /market-data/analyst-actions",
      ...CHART_PANE,
    ],
  },
  {
    id: "ipos",
    label: "IPOs",
    group: "Research",
    route: "/menu/ipos",
    source: "app/iq/screens/ipos.tsx",
    summary: "IPO calendar and the SEC registration pipeline.",
    apis: [
      "GET /live/snapshot",
      "GET /market-data/ipos",
      "GET /market-data/ipo-pipeline",
      "GET /market-data/companies",
    ],
  },
  {
    id: "insider",
    label: "13F & Insider",
    group: "Research",
    route: "/menu/insider",
    source: "app/iq/screens/insider.tsx",
    summary: "Insider transactions, institutional rollups, and per-ticker 13F holders and ownership.",
    apis: [
      "GET /live/snapshot",
      "GET /live/bars",
      "GET /live/13f-filings",
      "GET /live/ownership",
      "GET /market-data/insider-transactions",
      "GET /market-data/institutional-ownership",
      "GET /market-data/companies",
    ],
  },
  {
    id: "etf-corner",
    label: "ETF Corner",
    group: "Research",
    route: "/menu/etf-corner",
    source: "app/iq/screens/etf-corner.tsx",
    summary: "ETFs in ten categories; cached in the browser for a week.",
    apis: ["GET /live/snapshot", "GET /live/etf-market"],
  },
  {
    id: "ai-infrastructure",
    label: "AI Companies",
    group: "Research",
    route: "/menu/ai-infrastructure",
    source: "app/iq/screens/ai-infrastructure.tsx",
    summary: "AI-infrastructure themes and their companies.",
    apis: [
      "GET /live/snapshot",
      "GET /market-data/ai-infrastructure",
      "GET /market-data/ai-infrastructure/:theme",
    ],
  },

  // ── Market Recaps ──────────────────────────────────────────────────────────
  {
    id: "recap",
    label: "Recaps (daily / weekly)",
    group: "Market Recaps",
    route: "/menu/recap",
    source: "app/iq/screens/recap.tsx",
    summary: "The daily or weekly market recap with its supporting tables.",
    apis: [
      "GET /live/tape/stream",
      "GET /live/tape",
      "GET /market-data/recaps",
      "GET /market-data/sectors",
      "GET /market-data/earnings",
      "GET /market-data/earnings-announcements",
      "GET /market-data/news",
      "GET /market-data/macro-events",
      "GET /market-data/analyst-actions",
      "GET /market-data/companies",
    ],
  },

  // ── My Workspace ───────────────────────────────────────────────────────────
  {
    id: "portfolio",
    label: "Portfolio",
    group: "My Workspace",
    route: "/menu/portfolio",
    source: "app/iq/screens/portfolio.tsx",
    summary: "Holdings with live P/L, transaction history and an AI summary.",
    apis: [
      "GET /live/snapshot",
      "GET /market-data/companies",
      "GET /api/portfolio",
      "POST /api/portfolio/holdings",
      "GET /api/portfolio/holdings/:ticker/transactions",
      "DELETE /api/portfolio/holdings/:ticker/transactions/:txnId",
      "DELETE /api/portfolio/holdings/:ticker",
      "GET /api/ai/portfolio",
      "GET /live/search",
      ...CHART_PANE,
    ],
  },
  {
    id: "watchlist",
    label: "Watchlist",
    group: "My Workspace",
    route: "/menu/watchlist",
    source: "app/iq/screens/watchlist.tsx",
    summary: "The user's watchlists with live quotes and an AI summary.",
    apis: [
      "GET /live/snapshot",
      "GET /live/search",
      "GET /market-data/companies",
      "GET /api/watchlists",
      "POST /api/watchlists",
      "PATCH /api/watchlists/:id",
      "DELETE /api/watchlists/:id",
      "POST /api/watchlists/:id/tickers",
      "DELETE /api/watchlists/:id/tickers/:ticker",
      "GET /api/ai/watchlist",
      ...CHART_PANE,
    ],
  },
  {
    id: "notes",
    label: "Chart notes",
    group: "My Workspace",
    route: "/menu/notes",
    source: "app/iq/screens/notes.tsx",
    summary: "Notes left on charts. Linked from the profile menu; not in the left rail.",
    apis: [
      "GET /live/snapshot",
      "GET /api/stock-notes/all",
      "DELETE /api/stock-notes/:id",
      ...CHART_PANE,
    ],
  },

  // ── Stock tools ────────────────────────────────────────────────────────────
  {
    id: "stock",
    label: "Stock detail",
    group: "Stock tools",
    route: "/menu/stock",
    source: "app/iq/screens/stock.tsx",
    summary: "The full single-stock page: chart, key stats, financials, ownership, analysts, news, AI read, notes. Search routes here.",
    apis: [
      "GET /live/snapshot",
      "GET /live/stream",
      "GET /live/quotes",
      "GET /live/bars",
      "GET /live/company",
      "GET /live/company/summary",
      "GET /live/estimates",
      "GET /live/peers-summary",
      "GET /live/dividend-history",
      "GET /live/splits",
      "GET /live/ownership",
      "GET /live/financials",
      "GET /live/13f-filings",
      "GET /live/news",
      "GET /live/ai-analysis",
      "GET /market-data/companies",
      "GET /market-data/sectors",
      "GET /market-data/earnings",
      "GET /market-data/analyst-actions",
      "GET /market-data/analyst-history",
      "GET /market-data/analyst-firm-stats",
      "GET /market-data/insider-transactions",
      "GET /market-data/mover-catalyst/:ticker",
      "GET /market-data/etf-holdings",
      "GET /api/portfolio",
      "POST /api/stock-notes",
    ],
  },
  {
    id: "si",
    label: "Stock Intelligence",
    group: "Stock tools",
    route: "/si",
    source: "app/iq/si/stock-intelligence.tsx",
    summary: "A research workspace for one ticker, with an 'Ask AI' box.",
    apis: [
      "GET /live/snapshot",
      "GET /live/stream",
      "GET /live/search",
      "GET /live/bars",
      "GET /live/company",
      "GET /live/financials",
      "GET /live/news",
      "GET /live/ai-analysis",
      "GET /live/13f-filings",
      "GET /live/peers-summary",
      "POST /live/copilot",
      "GET /market-data/companies",
      "GET /market-data/earnings",
      "GET /market-data/analyst-actions",
      "GET /market-data/analyst-history",
      "GET /market-data/insider-transactions",
    ],
  },
  {
    id: "sl",
    label: "Strategy Lab",
    group: "Stock tools",
    route: "/sl",
    source: "app/iq/sl/lab-controller.jsx",
    summary: "Build and backtest rule-based strategies on stored price packs.",
    apis: [
      "GET /live/strategy-lab/bars",
      "POST /live/strategy-lab/validate",
      "POST /live/strategy-lab/ai-rules",
      "GET /live/logo",
    ],
  },
  {
    id: "options",
    label: "Options chain",
    group: "Stock tools",
    route: "/menu/options",
    source: "app/iq/screens/options.tsx",
    summary: "Options contracts for a short fixed list of tickers. Hidden from the nav.",
    apis: ["GET /market-data/companies", "GET /live/options-chain"],
  },
  {
    id: "filing",
    label: "Filing viewer",
    group: "Stock tools",
    route: "/filing?cik=&accession=",
    source: "app/iq/screens/filing.tsx",
    summary: "Renders one SEC filing in a sandboxed frame.",
    apis: ["GET /live/filing"],
  },

  // ── Account ────────────────────────────────────────────────────────────────
  {
    id: "auth",
    label: "Login & sign-up",
    group: "Account",
    route: "/auth/login, /auth/signup, /auth/forgot-password",
    source: "app/auth",
    summary: "Firebase sign-in; creates the profile on first login and claims this device's session.",
    apis: ["GET /api/profile", "PATCH /api/profile", "POST /api/session/claim"],
  },
  {
    id: "settings",
    label: "Settings",
    group: "Account",
    route: "/settings",
    source: "app/iq/screens/settings.tsx",
    summary: "Theme, font and alert preferences.",
    apis: ["GET /api/settings", "PATCH /api/settings"],
  },
  {
    id: "manage-plan",
    label: "Manage plan",
    group: "Account",
    route: "/manage-plan",
    source: "app/iq/screens/manage-plan.tsx",
    summary: "Plan comparison. Makes no backend call of its own — it renders from the profile already loaded by the shell.",
    apis: [],
  },
  {
    id: "profile",
    label: "Profile",
    group: "Account",
    route: "/profile/edit",
    source: "app/profile/edit/profile-edit-form.tsx",
    summary: "Edit the investor profile.",
    apis: ["GET /api/profile", "PATCH /api/profile"],
  },
  {
    id: "requests",
    label: "Feature requests",
    group: "Account",
    route: "/requests",
    source: "app/iq/screens/requests.tsx",
    summary: "Submit and list feature requests.",
    apis: ["GET /api/feature-requests", "POST /api/feature-requests"],
  },

  // ── Admin ──────────────────────────────────────────────────────────────────
  {
    id: "admin-data",
    label: "Admin · Overview, Users, Subscriptions, Revenue, Usage",
    group: "Admin",
    route: "/admin",
    source: "app/admin/admin-data.ts",
    summary: "The console's opening dataset, fetched once when it loads, plus the plan entitlement editor.",
    apis: [
      "GET /api/admin/users",
      "GET /api/admin/subscriptions",
      "GET /api/admin/feature-adoption",
      "GET /plans",
      "PATCH /api/admin/plans/:id",
    ],
  },
  {
    id: "admin-monitor",
    label: "Admin · Monitor",
    group: "Admin",
    route: "/admin/monitor",
    source: "public/admin/console.html",
    summary: "Backend route inventory, probes and vendor reachability.",
    apis: ["GET /api/admin/apihealth"],
  },
  {
    id: "admin-jobs",
    label: "Admin · Jobs",
    group: "Admin",
    route: "/admin/jobs",
    source: "public/admin/console.html",
    summary: "Every scheduled job, its health, and Run now.",
    apis: [
      "GET /api/admin/jobs",
      "GET /api/admin/jobs/runs",
      "POST /api/admin/jobs/:name/run",
    ],
  },
  {
    id: "admin-apidocs",
    label: "Admin · API Docs",
    group: "Admin",
    route: "/admin/apidocs",
    source: "public/admin/console.html",
    summary: "This catalogue: which screen calls which API, and status.",
    apis: ["GET /api/admin/screen-apis"],
  },
  {
    id: "admin-blogs",
    label: "Admin · Blogs",
    group: "Admin",
    route: "/admin/blogs",
    source: "app/admin/admin-console.tsx",
    summary: "The blog board and image library.",
    apis: [
      "GET /api/admin/posts",
      "POST /api/admin/posts",
      "PATCH /api/admin/posts/:id",
      "DELETE /api/admin/posts/:id",
      "GET /api/admin/media",
      "POST /api/admin/media",
      "DELETE /api/admin/media/:id",
    ],
  },
  {
    id: "admin-mcpkeys",
    label: "Admin · MCP keys",
    group: "Admin",
    route: "/admin/mcpkeys",
    source: "app/admin/admin-console.tsx",
    summary: "Keys that let Claude manage blog posts over MCP.",
    apis: [
      "GET /api/admin/mcp-keys",
      "POST /api/admin/mcp-keys",
      "POST /api/admin/mcp-keys/:id/revoke",
    ],
  },

  // ── Other consumers ────────────────────────────────────────────────────────
  {
    id: "website-landing",
    label: "Marketing site · landing page",
    group: "Other consumers",
    route: "marketcatalyst.ai/",
    source: "lib/market/tape.ts",
    repo: "MarketCatalystWebsite",
    summary: "The hero figures and marquee, fetched server-side and cached 30 s; the page renders its designed numbers if this is slow.",
    apis: ["GET /public/landing-tape"],
  },
  {
    id: "mcp-clients",
    label: "MCP clients (Claude Code / Desktop)",
    group: "Other consumers",
    route: "POST /mcp",
    source: "src/mcp",
    repo: "MarketCatalystBackEnd",
    summary: "External tools that author blog posts through the MCP server, authenticated by an MCP key.",
    apis: ["POST /mcp", "GET /mcp", "DELETE /mcp"],
  },
  {
    id: "ops-monitor",
    label: "Ops monitor (worker)",
    group: "Other consumers",
    route: "/ on the private worker, via gcloud run services proxy",
    source: "public/index.html",
    repo: "MarketCatalystBackEnd",
    summary: "The worker's own page: run a job, preview and execute a purge, toggle feature flags. Not reachable from the public internet.",
    apis: [
      "GET /sync/jobs",
      "GET /sync/status",
      "GET /sync/:job/status",
      "POST /sync/:job/run",
      "POST /sync/run-all",
      "GET /purge/targets",
      "POST /purge/preview",
      "POST /purge/execute",
      "GET /retention/preview",
      "POST /retention/run",
      "GET /feature-flags",
      "GET /feature-flags/map",
      "POST /feature-flags/seed",
      "POST /feature-flags/:key",
      "POST /plans/seed",
      "GET /users/:uid/entitlements",
    ],
  },
] as const satisfies readonly ScreenDoc[];

// ── Derived views ────────────────────────────────────────────────────────────

export interface ApiDoc extends ApiBody {
  key: CatalogKey;
  method: HttpMethod;
  path: string;
}

export function splitKey(key: string): { method: HttpMethod; path: string } {
  const at = key.indexOf(" ");
  return { method: key.slice(0, at) as HttpMethod, path: key.slice(at + 1) };
}

export const API_DOCS: readonly ApiDoc[] = (
  Object.keys(API_CATALOG) as CatalogKey[]
).map((key) => ({
  ...(API_CATALOG[key] as ApiBody),
  key,
  ...splitKey(key),
}));

/** Screens that call each API, by key. APIs no screen calls are simply absent. */
export function screensByApi(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const screen of SCREENS) {
    for (const key of screen.apis) {
      const list = out.get(key) ?? [];
      list.push(screen.id);
      out.set(key, list);
    }
  }
  return out;
}

/**
 * What "Run checks" should send for an API: a path+query to GET, or the reason
 * it is not checked. Only plain GETs are ever checked — anything that writes,
 * streams or starts an LLM generation is skipped — and the default for a GET is
 * conservative: with no parameters it is called as is, with parameters but no
 * sample it is skipped rather than guessed at.
 */
export function checkRequest(
  doc: Pick<ApiDoc, "method" | "path" | "sse" | "params" | "check">,
): { url: string } | { skip: string } {
  if (doc.method !== "GET") return { skip: "changes data" };
  if (doc.sse) return { skip: "a Server-Sent Events stream" };
  if (doc.check && "skip" in doc.check) return { skip: doc.check.skip };
  if (doc.path.includes(":")) return { skip: "needs a path parameter" };
  const query = doc.check && "query" in doc.check ? doc.check.query : undefined;
  if (!query && doc.params) return { skip: "needs parameters, and no sample is defined" };
  return { url: `${doc.path}${query ?? ""}` };
}
