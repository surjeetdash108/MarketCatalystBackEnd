# MarketCatalyst — Feature Tracker

> ## ⏱ State sync — 2026-07-27 · TWO ENVIRONMENTS (stage + prod), env-driven config
>
> _This block is newest and authoritative where it differs from the blocks
> below. It introduces a second, fully-isolated environment; nothing about the
> per-environment runtime topology (§6, the on-demand data layer, the CDN
> rewrite) changes — that topology now simply exists twice, once per project._
>
> **This doc, specifically:** Feature status is environment-agnostic — stage
> runs the identical codebase, so every feature's status here applies to prod
> today and to stage once its backend is deployed.
>
> **Two isolated Firebase projects = two environments.** Production stays on
> `market-catalyst-502415`. A new **stage** project `market-catalyst-stage`
> (project #523639228835) was created as an independent copy: its own Firestore
> `(default)` in **nam5 / STANDARD / NATIVE** (identical region/edition to prod),
> the **same `firestore.rules` + `firestore.indexes.json`** deployed to it, its
> own Auth, and its own `backend-runtime@…` service account (roles
> `datastore.user` + `secretmanager.secretAccessor`, mirroring prod — keyless,
> the backend authenticates via ADC). Nothing is shared between the two: a
> destructive sync, a rules change, or a test signup on stage can never touch
> prod data or users.
>
> **Branch ⇄ environment.** Both repos work on the **`stage`** branch for
> day-to-day work; `main`/`prod` map to production. `.firebaserc` carries
> `stage`/`prod` aliases so `firebase deploy … --project stage|prod` targets the
> right project.
>
> **Firebase config is env-driven now, not hardcoded.**
> · **Backend** reads `FIREBASE_PROJECT_ID` (previously pinned to prod). Stage
>   `.env` and `deploy/env.stage.yaml` set it to `market-catalyst-stage`;
>   `deploy/env.production.yaml` keeps prod. Same image, same code — only the env
>   var differs.
> · **UI** reads `NEXT_PUBLIC_FIREBASE_*` (`app/firebase.ts`), falling back to
>   the prod values for zero-regression. The stage build sets them via
>   `.env.production` to the stage web-app config, so the deployed stage site
>   authenticates against `market-catalyst-stage`.
>
> **UI backend base URL is resolved at RUNTIME** (`app/iq/backend.ts`), so one
> static build works in every environment without a rebuild:
> · local dev (`localhost`/`127.0.0.1`) → `http://localhost:4400`;
> · deployed on Firebase Hosting → **same-origin** (the site's own Firebase base
>   URL), and `firebase.json` rewrites `/api/**`, `/market-data/**` and
>   `/live/**` to the public `market-catalyst-live` Cloud Run service (no CORS,
>   CDN-cacheable). A `localhost` value of `NEXT_PUBLIC_BACKEND_URL` is ignored
>   once the page is served from a real host, so a dev env baked into a prod
>   build can never misroute deployed traffic. This is the **same implementation
>   for stage and prod** — the only per-env difference is which project's
>   `market-catalyst-live` the rewrite resolves to.
>
> **Per-environment Cloud Run topology is unchanged** (see §6): one image → a
> private `worker` (`market-catalyst-backend`, all sync/admin/plans) and a public
> `live` (`market-catalyst-live`, serving `LiveModule` + `MarketDataModule` +
> `UserDataModule`, i.e. `/live` + `/market-data` + `/api`). Each project gets
> its own pair.
>
> **Stage data = a full copy of prod.** All 35 Firestore collections (18,748
> top-level docs + subcollections: users' portfolios/holdings, watchlists,
> sessions; fund_holdings' filings/positions) were copied prod → stage so stage
> mirrors production.
>
> **Stage status / open items (2026-07-27).**
> · Stage **billing is not yet linked** (free/Spark). Firebase Hosting **Cloud
>   Run rewrites and any Cloud Run deploy require billing**, so the stage
>   `firebase.json` currently ships the **SPA catch-all only** and the stage
>   `live`/`worker` services are **not deployed yet**. Re-add the rewrites (see
>   prod) once billing + the stage `market-catalyst-live` service exist.
> · The stage **static UI is live** at `https://market-catalyst-stage.web.app`.
> · Google sign-in on stage reaches Google but needs the stage project's **OAuth
>   consent screen published / test-users added** to complete; Email/Password
>   works today.


> ## ⏱ State sync — 2026-07-26 (evening) · CDN, zero-poll, spinners, DB reset EXECUTED
>
> _Additive to the morning 2026-07-26 on-demand block below; nothing prior is
> removed. Where they differ, this block is newest._
>
> **DB reset executed.** `deploy/empty-market-data.mjs` was RUN against
> production: **323,575 market-data docs deleted** across 29 collections
> (ohlcv_bars ~300k, tickers ~13k, news ~5.6k, …). Users, watchlists,
> portfolios, sessions, settings, plans and feature flags were kept. The DB now
> starts empty and grows strictly with usage + the premarket warm.
>
> **Spinners app-wide (first-fetch UX).** Every on-demand path now shows a
> spinner while data is being fetched and an honest empty state if none exists:
> the Dashboard's single grid spinner, the shared `DataState` loading state,
> the chart pane (spinner while `/live/bars` is in flight — and the last
> fabricated fallback, `genOHLC`'s seeded random-walk chart, was **removed**),
> the stock page and stock drawer (`useCompanyState`, ~12 s bounded grace while
> `/live/company` lands).
>
> **Zero vendor/client polling while the market is closed.** Client price poll:
> one fetch to populate, then silent until 04:00 ET (local clock check, no
> network); hidden tabs never poll and refresh instantly on return. Snapshot
> cache: zero Polygon calls when closed (cold-start exception only). Tape:
> skips the vendor entirely once a clean closing frame exists; a 15-min phase
> check is the only reopen signal (market-status, 60 s TTL, ~1 light call/min
> server-wide). WebSocket: never opens (unused path, kept for a future
> real-time plan).
>
> **Firebase Hosting free CDN.** `firebase.json` rewrites `/live/**` on the
> Hosting origin to the public `market-catalyst-live` Cloud Run service. The UI
> (`app/iq/backend.ts`) calls same-origin on `*.web.app`/`*.firebaseapp.com`
> (→ rides Hosting's global CDN, cached per each endpoint's Cache-Control/
> s-maxage; no CORS) and the direct Cloud Run URL in dev. **SSE stays direct**
> (Hosting buffers streams). `/live/whoami` is `no-store` so the CDN can never
> cache one user's IP for another. 11 UI consumers rewired.
>
> **SSE decision.** The tape keeps SSE while its compute stays under
> ~$1/month (roughly ≤300 concurrent viewers; ref-counted, 0 viewers = $0).
> Past that, the pre-built fallback — polling the CDN-cached `GET /live/tape`
> (s-maxage=60) — is a ~30-minute switch that collapses 10k viewers to ~1
> origin request/minute.
>
> **Cost (honest, at 10k users).** Firestore **≈ $0.70/mo** — the <$1 target,
> met. Whole GCP infra **≈ $10–25/mo** at genuinely 10k daily-active (network
> egress + concurrent compute are bandwidth physics, not design slack); ~$2–5
> if ~1k are active daily. The Polygon subscription (~$2,000/mo) dominates
> everything — see `Polygon-vs-Finnhub-Vendor-Comparison.pdf`.


> ## ⏱ State sync — 2026-07-26 (ON-DEMAND DATA LAYER redesign)
>
> _This block supersedes any earlier description of scheduled full-universe
> syncing. The data layer is now on-demand._
>
> **Design.** The app no longer pre-syncs a fixed ticker universe. Firestore
> starts EMPTY (market-data collections) and grows strictly with usage:
> `GET /live/bars?ticker&tf` and `GET /live/company?ticker` check Firestore
> (every doc carries **`createdAt`** + a per-resolution TTL) → on miss make ONE
> coalesced Polygon call → write back → serve. Repeat users hit the shared
> cache; browsers additionally cache via Cache-Control+ETag (304s).
>
> **Bars storage.** One doc per (ticker, resolution family) in `stock_bars/`:
> `_1min` (1H) · `_5min` (1D/1W) · `_30min` (1M) · `_daily` (3M/6M/1Y/5Y,
> **widen-in-place**: a 1Y request upgrades a 3M doc in place; narrower
> timeframes are served as slices of the wider doc with zero vendor calls).
> The old per-bar `ohlcv_bars` (≈300k docs) is retired as a client read path
> (it remains only as the internal substrate the indicator jobs read).
>
> **Usage tracking.** Every on-demand fetch increments **`ticker_usage/{t}`**
> (batched ≤1 write/min/ticker) — the gradually-built record of which stocks
> are REALLY used.
>
> **One premarket cron.** A single Cloud Scheduler job (`sync-premarket`,
> 08:00 ET weekdays → `/sync/premarket/run`) replaces all 22 scattered jobs
> (deleted; in-code `@Cron` decorators removed). Phases: ① warm the
> high-frequency set's company PROFILES only (tape universe + every user's
> watchlist/portfolio + `ticker_usage` top-100) — bar history is strictly
> on-demand and INCREMENTAL (only days since the last stored bar are fetched;
> a 5-year series is never re-downloaded); ② market-wide jobs
> (indices, sectors, movers, breadth, F&G, calendars, news, insider);
> ③ per-ticker compute jobs over the **dynamic universe** (= `companies` ids,
> i.e. only used tickers — the fixed 241-ticker list is retired);
> ④ recap (freezes the prior session). Intraday freshness comes from the live
> layer (SSE tape, /live/snapshot, on-demand TTLs), not from re-running batch
> syncs — no other cron frequency is required.
>
> **Search.** `GET /live/search?q=` — in-memory index over the full ~13k
> Polygon reference universe, per instance, refreshed daily. The `tickers`
> collection (10k docs) is retired: search costs ZERO Firestore reads and now
> matches substrings.
>
> **Presence cost fix.** Heartbeat 90s → 30 min (client-gated); ~2-4 writes
> per active user per day. Presence read convention: online = `isOnline` and
> `lastSeenAt` fresher than ~35 min.
>
> **Firebase cost @ 10k users/month (nam5 pricing, free tier ignored —
> conservative):** shared/cached reads ≈ $0.04 · owner-scoped reads
> (watchlist/portfolio/settings, ~10 docs/session) ≈ $0.45 · writes (presence
> + premarket + usage) ≈ $0.20 · storage < free 1 GB ⇒ **≈ $0.70/month
> total — under the $1 target.** Reads no longer scale with (users × docs)
> anywhere; the dominant remaining term is owner-scoped reads, linear in
> sessions, not in market data.
>
> **Reset.** `deploy/empty-market-data.mjs` empties ONLY market-data
> collections (DRY_RUN by default; users/settings/plans/flags kept).



> ## ⏱ State sync — 2026-07-24 (current deployed reality)
>
> _This block reflects what is actually built, deployed, and running as of
> 2026-07-24. Where anything below predates it, this block is authoritative._
>
> **This doc, specifically:** For features: live prices, Recaps, F&G history, EPS/Sales + Income-statement tabs, screener, and heatmap/dashboard real-data are all shipped.
>
> **Infrastructure (live).** One image → **two Cloud Run services** split by
> `APP_ROLE`: a **private `worker`** (`market-catalyst-backend` — all
> sync/admin/plans) and a **public `live`** (`market-catalyst-live` — `LiveModule`
> only; `/sync`·`/purge`·`/admin` 404 there). **22 Cloud Scheduler jobs are
> ENABLED and firing** (OIDC via the `scheduler-invoker` SA). The browser reaches
> the backend through the public `live` service (`NEXT_PUBLIC_BACKEND_URL`).
> Vendor keys in **Secret Manager**. Firestore: **34 collections, ~322k docs**.
>
> **Live data paths.** SSE ticker tape (`/live/tape/stream`), cached snapshot
> polling (`/live/snapshot`, backing a **shared live-price subscription** across
> tape / watchlist / portfolio / search / stock), market status
> (`/live/market-status`), and a new **`/live/collections`** endpoint that serves
> the shared, slow-changing collections from a **5-minute server-side cache**
> (Cache-Control + ETag/304) so per-user Firestore reads no longer scale with
> user count.
>
> **Data completeness (this session).** Real **4-component Fear & Greed** + history
> backfill (`market_sentiment_history`); **Recaps EOD job** writing `recaps/`
> per-date docs (prose narrative stays AI, tracked under R36); **macro regime**
> computed from VIX/breadth/yield; financials now carry **10 quarters + 8 annual
> years** (income / balance / cash-flow) driving the **EPS & Sales** and **Income
> statement** *Quarterly / Yearly* tabs; screener filters wired; stock detail
> fully Polygon-real; **TradingView removed**; heatmap **sector + stock modals**
> and the dashboard **Market Pulse** wired to real `companies` (fabricated
> ranges / news / sector rows removed).
>
> **Vendor / licensing.** **Polygon/Massive is the ONLY vendor whose data reaches
> users** (licensed for redistribution). FMP / Finnhub are **worker-only** and are
> never served to the browser. **15 Polygon endpoints** are in use (see
> `architecture-map.html`). The one remaining gap is EPS **estimates** (need
> Polygon's Benzinga add-on). Alpha Vantage was evaluated (~85% data coverage but
> a redistribution-licensing blocker); OpenRouter is a viable option for the AI
> layer (AI output is not market-data redistribution).
>
> **Delivery plan.** **21 of 36 rows at 100%** (R26 Fear & Greed, R28 Recaps, R30
> macro complete; R29 capped at 90% pending Benzinga estimates).
>
> **Cost.** GCP/Firebase infra ~**$3–5/month** at current usage (scale-to-zero,
> one vendor call fanned out to all users, shared reads cached); the Polygon data
> subscription is the dominant fixed cost.

v1.4 | July 2026

> **⚠ Implementation status (updated 2026-07-22):**
> Two bodies of work landed since v1.3: **(A) Polygon data wiring** and
> **(B) subscriptions / entitlements / admin analytics**.
> (A) replaced synthetic data on Stock Detail (real 52-week range, SMA/EMA
> ladders, VWAP, peers, dividend history, balance sheet + cash flow, real RSI),
> made **all 7 chart timeframes real** (1D/1W/1M from the new `intraday_bars`
> collection, 3M–5Y from a 5-year `ohlcv_bars` backfill), gave Options real
> per-contract OHLC/VWAP, and fixed US10Y (was the TLT ETF, which moves
> *inversely* to the yield it was labelled as). (B) added a `plans` registry with
> 30 entitlement keys, three plans in Firestore, an admin analytics API, a
> per-plan feature editor, and 48-feature adoption tracking.
> **Deployment reality — read before trusting any "Complete" below:** backend is
> Cloud Run revision `market-catalyst-backend-00031-wvc` with
> `--no-allow-unauthenticated`, and `NEXT_PUBLIC_BACKEND_URL` is unset, so the
> production bundle points at `http://localhost:4400` and **the browser cannot
> reach the backend at all**. Anything requiring a backend call is
> BUILT-BUT-NOT-DEPLOYED, not live. Separately, **no Cloud Scheduler jobs exist
> in any region** — with `min-instances=0` the in-process `@Cron` decorators
> never fire, so no sync job has ever run automatically in production; all
> Firestore data came from manual runs. Notes below are annotated
> **LIVE** / **BUILT — NOT REACHABLE IN PROD** / **NOT BUILT** where it matters.
>
> **⚠ Implementation status (updated 2026-07-09, first noted 2026-07-05):**
> The frontend UI completion notes below are accurate. However, "real-time
> WebSocket data" / backend integration notes scattered throughout
> (Dashboard F-01, Movers, Analyst Actions, etc.) describe a Redis/WebSocket
> architecture that was never built — real data instead flows from
> `backend/src/sync/*.job.ts` cron jobs into Firestore, read directly by the
> frontend via `useCollection()` (or a scoped query hook for large/growing
> collections — see `useOhlcvBars.ts`/`useTickerSearch.ts`). Shipped since
> this note was first added: full US ticker-universe search (Cmd+K),
> Screener's RS Rating, a Polygon-primary news upgrade, and materialized
> portfolio totals on top of the pre-existing watchlist/holdings CRUD. See
> `Doc/screen-data-sources.md` for an accurate, currently-maintained
> per-screen live/static breakdown, and `Doc/openapi.yaml` for the real
> data contract.

**Status values:** Not Started | In Progress | In Review | Complete  
**Tier:** Free+ | Pro+ | Premium | All

---

## Pre-App

### Landing Page — `/`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-47 | MarketCatalyst Landing Page + Modal Login | MVP | All | **Complete** | 100% | Full Stack | Standalone marketing page at `app/page.tsx`. Dark radial gradient + animated perspective grid (spPan). Sections: hw-nav (sticky glassmorphism navbar), hw-hero (headline + "What Matters Now" live mock frame), hw-commit (commitment block, hwSheen animation, 2 cards), hw-steps (5 alternating step+mock-frame sections), hw-tabs-sec (14 workspace cards, gradShift+hwShine hover), hw-final (CTA). Scroll-reveal via IntersectionObserver (`.reveal` → `.reveal.in`). "Log in" opens inline modal overlay — no navigation. "Sign up" → /auth/signup. Modal: LoginForm in glassmorphism card, ✕ + Escape to close, logo button closes modal. CSS: `app/landing.css`. WebGL wave animation now visible: `.lp-root.mq-root { background: transparent }` (was `#000`). `ScaledScreen` uses `ResizeObserver` for dynamic scale (`containerWidth/1200`) instead of hardcoded 0.2834 — fixes glance-modal card at any width. |

### Auth Pages — `/auth/*`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-43 | Auth Pages — MarketCatalyst Theme | MVP | All | **Complete** | 100% | Full Stack | Login, Signup, Forgot Password with MarketCatalyst dark theme. Two-panel AuthLayout: LEFT = marketing panel (MarketCatalyst wordmark, gradient shimmer tagline, 8 animated feature pills with staggered spUp animation), RIGHT = glassmorphism form card (backdrop-filter blur, spRightIn animation). Google OAuth + email/password. Shared `app/auth/auth-layout.tsx`. Routes: /auth/login, /auth/signup, /auth/forgot-password. All logos → /. Signup "Sign in" → /. Forgot "Back to sign in" → /. Mobile responsive fix: added classes `lp-auth-cols` / `lp-auth-left` / `lp-auth-form` to wire inline media queries. `≤900px` stacks columns; `≤600px` hides marketing panel, form goes full-width. Firebase Auth iOS Safari fix: `signInWithPopup` first, `signInWithRedirect` fallback on popup-blocked. `getRedirectResult` on mount in both LoginForm and SignupForm. `initializeAuth` with `indexedDBLocalPersistence` + `browserLocalPersistence` (ITP-safe). |

---

## Intelligence

### Dashboard — `/dashboard`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-01 | Home Dashboard — What Matters Now | MVP | Pro+ | **In Progress** | 80% | Full Stack | UI complete: Pulse strip (6 cards, clickable openIndex), col-4×3 (Portfolio Pulse, Watchlist, Heatmap mini), col-8 (WMN + Live Feed stacked), col-4 (VIX, F&G, Earnings Today, Analyst Actions, Market Movers). Session filter tabs removed. Modal/popover pattern (centered, animated) replaces right-side sliding drawer. Remaining: real-time WebSocket data, drag/drop widget grid, audio recap button. |
| F-08 | Before the Bell Briefing | MVP | Pro+ | **Not Started** | 0% | Backend | Pushed summary at 8:30am ET. Covers: futures, overnight news, macro events today, BMO earnings. Delivered in-app + email. |
| F-09 | After the Close Briefing | MVP | Pro+ | **Not Started** | 0% | Backend | Pushed summary within 30 min of market close. Covers: final indices, top stories, next-day preview (earnings, macro, Fed speakers). Delivered in-app + email. |
| F-55 | Dashboard Market Movers Widget — Winners & Losers | MVP | Pro+ | **Complete** | 100% | Full Stack | `col-4` widget with Winners/Losers tabs, scrollable list of 15 stocks per tab, sector + market cap filter dropdowns, per-row `.mv-dash-row` hover popup showing Technical/News tabs with relevant data. Fits alongside Heatmap widget on same row (both col-4). File: `screens/dashboard.tsx`. |
| F-53 | Trending Stocks Dashboard Widget | MVP | Pro+ | **Complete** | 100% | Full Stack | `col-12` row at bottom of dashboard grid. Inline `computeTrending()` cross-references movers + analyst + earnings data to surface multi-day momentum stocks. Shows trending score, catalyst pills, volume surge indicators. File: `screens/dashboard.tsx`. |

### Earnings — `/menu/earnings`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-02 | Earnings Calendar | MVP | Free+ | **In Progress** | 60% | Full Stack | Views: Today/Tomorrow/This Week/Next Week/Custom. Kanban BMO/AMC grid. Row columns: ticker, report time, cap bucket, sector, EPS actual/est/surprise%, Rev actual/est/surprise%, guidance status, post-print reaction. Tag pills: Beats EPS, Misses Rev, Raises Guide, Lowers Guide, Inline, Mixed, High Short Interest, Large Move, Options Active. Side-by-side layout: calendar `col-6` + EPS history `col-6` (fixed from previous col-7 overflow). |
| F-49 | Earnings Inline Detail Panel | MVP | Free+ | **Complete** | 100% | Full Stack | When an earnings row is selected (`selEarning` state), an accordion-style detail panel appears inline below the calendar — no drawer or modal. Shows: company logo, name, sector, timing pill, EPS estimate, EPS actual, guidance status, price reaction/implied move, AI-generated read. File: `screens/earnings.tsx`. |
| F-03 | Earnings Detail Drawer | MVP | Free+ | **Not Started** | 0% | Full Stack | Full right-side drawer (70% width desktop, full mobile). Tabs: Summary / Transcript / Audio / News / Peers. EPS/Rev headline metrics, guidance summary, 8-quarter history chart, earnings transcript, call audio player, latest news 24h, peer reactions. Embeds F-06 AI summary. |
| F-04 | Earnings Setup Card (Pre-Announce) | MVP | Pro+ | **Not Started** | 0% | Full Stack | Pre-announcement card per scheduled ticker: implied move (options), last 4 earnings reactions, analyst sentiment trend 30d, peer performance pre-announcement, key questions for quarter. |
| F-05 | Earnings Movers Board | MVP | Free+ | **Not Started** | 0% | Full Stack | Auto-list: stocks with largest post-earnings moves today and this week. Columns: ticker, reaction %, direction, beat/miss, guidance status, sector, portfolio flag. Sorted by absolute move size. |
| F-06 | AI Earnings Summary | MVP | Pro+ | **Not Started** | 0% | AI + Backend | Generated within minutes of transcript availability. Output: What happened, Beat/miss with context, Guidance (verbatim quote), Management tone, Segment highlights, Risks, Investor reaction, What to watch. One-line takeaway. Confidence label + disclaimer. |
| F-35 | Earnings Call Audio Player | Phase 2 | Premium | **Not Started** | 0% | Full Stack | Compact audio player in earnings detail drawer. Source: Intrinio. Features: play/pause, timestamp seek, speed control. |

### Market Movers — `/menu/movers`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-10 | Market Movers Board | MVP | Free+ | **In Progress** | 40% | Full Stack | View tabs: Top Gainers, Top Losers, Unusual Volume, Gap Ups, Gap Downs, High Relative Volume, Large-Cap Movers, Weekly Movers. Row/trending-pill click opens `stock-side-drawer` with full embedded StockScreen (dynamic import, no modal). Removed mvpop hover tooltip. Remaining: real API data, weekly tab, filters. File: `screens/movers.tsx`. |
| F-11 | Weekly Movers Page | MVP | Free+ | **Not Started** | 0% | Full Stack | Published Friday, available through weekend. Top 10 up + top 10 down for the week. Each: ticker, weekly % change, short catalyst (earnings/analyst/macro/news). |

### Market Heatmap — `/menu/heatmap`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| *(F-01)* | Heatmap Mini Widget | MVP | Free+ | **In Progress** | 70% | Full Stack | Treemap grid with heatCol() for tile bg + text color. Embedded in Dashboard col-4×3 widget. Full-screen heatmap at /menu/heatmap. |

### Analyst Actions — `/menu/analyst`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-12 | Analyst Actions Board | MVP | Pro+ | **In Progress** | 40% | Full Stack | Real-time board: upgrades, downgrades, initiations, reiterations, PT changes. Columns: ticker, firm, prev/new rating (direction arrow), prev/new PT, implied upside/downside, time, stock reaction since action, action count 30d. Filters: upgrade/downgrade/initiation/PT-change only, major banks, portfolio/watchlist. AI note per action. |
| F-48 | Analyst Flags — 5+ Action Alert | MVP | Pro+ | **Complete** | 100% | Full Stack | Front-end `computeFlags()` counts analyst actions per ticker from `data.analyst`. Stocks with ≥5 actions get a flag card in the sidebar showing firm list (upgrades + downgrades). Top 3 upgrades by n30/react surfaced in a separate "Top Upgrades" block. File: `screens/analyst.tsx`. Data: `app/iq/data.ts` has CRM (6 entries) and NVDA (5 entries) to trigger the flag. |
| F-62 | Analyst Screen Layout — Full-Width AI Take + Rating Table | MVP | Pro+ | **Complete** | 100% | Full Stack | ◆ AI take · CRM cluster section moved from col-4 sidebar to full-width `<div className="ai-block">` between signal cards (🔥 Cluster alert / My names PT) and the filter bar. Rating table now full-width single card (removed `<div className="dash">` wrapper and col-8 split). Atomic subtasks: (1) extract AI take block from col-4 sidebar; (2) insert as `.ai-block` after signal row; (3) remove `.dash` wrapper from table card. File: `screens/analyst.tsx`. |

### Screener — `/menu/screener`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-45 | Stock Screener — Filter Logic | MVP | Pro+ | **In Progress** | 75% | Full Stack | 9 checkbox filters live-wired to `screenerStocks` array. 20 named presets (dropdown + browse overlay). `applyPreset(idx)` maps `screenerPresets[idx].f` fields back to individual checkbox state. Auto-fallback: `selStock = filtered.find(s => s.s === scrSel) ?? filtered[0] ?? null`. Backend/real data: Not Started. |
| F-63 | Screener Stock Panel Layout | MVP | Pro+ | **Complete** | 100% | Full Stack | Screener rewritten to match portfolio/watchlist layout: 340px StockListCard (filter preset header + StockRow results) + ChartCard (right, flex-1) + StockScreenEmbed (below). `selPx` resolved from `watchData` or `moversData`. Atomic subtasks: (1) wrap filter card + results list in StockListCard; (2) add ChartCard with TF selector; (3) embed StockScreenEmbed below. File: `screens/screener.tsx`. |

### IPOs — `/menu/ipos`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-46 | IPOs & Recent Performance | MVP | Free+ | **Complete** | 100% | Full Stack | Stats strip (above-offer count, best performer, median return). Tabs: (1) Recent performance — 8 recent IPOs with ticker/company/sector/IPO date/offer/current/Day-1/since-IPO return, click-to-open Stock Detail; (2) Upcoming pipeline — 4 expected new issues. File: `screens/ipos.tsx`. Slug: `ipos`. Static data; prod source: SEC EDGAR + Polygon.io. |

### Stock Detail — `/menu/stock`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-17 | Stock Detail Page | MVP | Free+ | **In Progress** | 85% | Full Stack | UI complete: sym selector bar (fbar), sd-head (logo/name/price/actions), sd-grid (chart col + ratings col). CandleChart SVG + RsiPane. Key stats grid. AI Technical Analysis. Financials bar chart. TrGauge (5-segment Technical Rating) + indicator table, Peers minirows, Industry Group rank, Earnings history, Insider/Institutional section. **Real data as of 2026-07-22 (LIVE, Firestore-read — no backend call needed):** 52-week high/low + `pctFromHigh52`/`pctFromLow52` (`has52w` guard, falls back to ±2% band when absent); SMA and EMA ladders at 10/20/30/50/100/200 (`smaLadder`/`emaLadder`); VWAP (key-levels row shows Above/Below VWAP from the real value); real peers from Polygon `/v1/related-companies` (`liveCompany.peers`, sector-filter fallback for untracked tickers); dividend history card + drawer from `dividend_history/{ticker}` via `useDividendHistory` (annual totals, TTM, derived yield, 5-yr CAGR, payout, ex-div countdown, explicit "Dividend suspended" state for lapsed payers); balance sheet + cash flow in the financials drawer (`fin.hasBalanceSheet`) from `financials.job.ts`, which previously fetched and discarded them; split-adjusted disclosure note backed by `splits/{ticker}`; **RSI pane is now real** — `RsiPane` receives `company.rsi14Series` (90-point rolling RSI-14) instead of a seeded walk. Files: `app/iq/screens/stock.tsx`, `app/iq/hooks/useCompany.ts`, `useDividendHistory.ts`, `useSplits.ts`, `useFinancials.ts`. Remaining: interactive zoom, options/block-trades sections, AI narrative (F-31, still NOT BUILT — all "AI Technical Analysis" copy on this screen is fabricated static text). |
| F-65 | Extended-Hours / Market-Status Strip | MVP | Free+ | **In Progress** | 60% | Full Stack | Snapshot cache upgraded v2 → **v3 universal snapshot**, adding `earlyTradingChangePct`, `lateTradingChangePct`, `regularTradingChangePct`, `marketStatus`. New `src/live/market-status.service.ts` + `GET /live/market-status`. Frontend `useExtendedHours` hook consumes it. **BUILT — NOT REACHABLE IN PROD:** both the extended-hours moves and the vendor market-status pill go through the backend HTTP API, which the browser cannot reach (see header note). Works locally against `localhost:4400`. |
| F-50 | Stock Chart Right-Click Notes (Firebase) | MVP | Pro+ | **Complete** | 100% | Full Stack | Right-click context menu on chart div. Opens centered modal with textarea. Saves to Firestore `stock_comments` collection: `{uid, sym, name, comment, createdAt: Timestamp}`. Notes card below chart shows history with datetime + ✕ delete per note. `loadNotes()` / `saveNote()` / `deleteNote()` async helpers using `collection, addDoc, getDocs, query, where, orderBy, Timestamp, deleteDoc, doc`. `useCallback` + `useEffect` refreshes notes on symbol change. File: `screens/stock.tsx`. |
| F-18 | Peer View | MVP | Pro+ | **Not Started** | 0% | Full Stack | 5–10 closest peers by sector/industry group/business model. Table: ticker, 1D/1W/1M perf, market cap, next earnings date, analyst rating consensus, valuation snapshot. |
| F-19 | Group View (MarketSurge-style) | MVP | Pro+ | **Not Started** | 0% | Full Stack | Industry group rank vs all groups, trend, strongest/weakest names in group, group-level news + analyst activity. |
| F-31 | AI Technical Analysis | Phase 2 | Pro+ | **Not Started** | 0% | AI + Full Stack | 4 tone modes: Short Summary / Swing Trader View / Position Trader View / Long-Term Investor View. Labeled AI-generated, not investment advice. |
| F-41 | Peer RS vs EPS Growth Scatter Matrix | Phase 2 | Pro+ | **Not Started** | 0% | Full Stack | 2D bubble chart: RS (X-axis) vs EPS Growth Rate (Y-axis) for all peers/group members. |

### Options Chain — `/menu/options`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-57 | Options Chain Screen | MVP | Pro+ | **In Progress** | 55% | Full Stack | Left stock search sidebar + main chain table (calls left / puts right) with strike, bid, ask, IV%, OI, volume columns. Expiry date tab selector (horizontal scroll on mobile). Filter: calls/puts/both. Click row → opens stock detail. File: `app/iq/screens/options.tsx`. **Partly real as of 2026-07-22 (LIVE):** `options-chains.job.ts` now stores per-contract full **OHLC, VWAP, trade count and range %** (`lastOpen`/`lastHigh`/`lastLow`/`lastClose`/`lastVwap`/`lastTradeCount`/`lastRangePct`), read from the `options_chains` docs via `useCollection`. Contract-level aggregates are authorized on the current Polygon plan. **Still fabricated and NOT obtainable on this plan (hard 403 `NOT_AUTHORIZED` on the options snapshot endpoint): greeks, implied volatility, open interest, and bid/ask.** Those columns are seeded pseudo-random values (`optRand`) and cannot be made real without a Polygon options add-on — this is a vendor-plan block, not a build gap. |

### Insider & Institutional — `/menu/insider`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-26 | Insider & Institutional — Fund Tracker + Insider Feed | Phase 2 | Premium | **In Progress** | 50% | Backend | Two tabs: (1) Insider activity — Form 4 feed table, filter by Buys/Sells/10% owners, sort by value or date, most-active chips; (2) 13F institutional — fund cards + AI summary + cross-fund signals. Top 5 most-followed funds. Sources: SEC EDGAR 13F-HR + Form 4. Slug: `insider`. File: `screens/insider.tsx`. UI complete, static data. |
| F-27 | 13F Quarterly Digest & AI Summary | Phase 2 | Premium | **Not Started** | 0% | AI + Backend | Per fund per quarter: new positions, added, trimmed, exited, unchanged. AI summary. |
| F-28 | Cross-Fund Views | Phase 2 | Premium | **Not Started** | 0% | Full Stack | "Most owned across tracked funds", "Most sold", "Only one fund owns this". Co-Attribution Screener. |
| F-29 | Unusual Options Activity Board | Phase 2 | Premium | **Not Started** | 0% | Full Stack | Rows: ticker, call/put, strike, expiry, premium paid, contract size, total value, vol/OI ratio, direction flag. Powered by Unusual Whales API. |
| F-30 | Block Trades Board | Phase 2 | Premium | **Not Started** | 0% | Full Stack | Rows: ticker, trade value, shares, price, price vs VWAP, time, direction context. Powered by Polygon.io Trades. |

### Commentary — `/menu/commentary`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-07 | Live Market Feed | MVP | Free+ | **In Progress** | 80% | Full Stack | Commentary screen has 5 functional filter tabs: Live (all items), Premarket, After Hours, My names, Macro. FeedItem component shared across tabs. Ticker search bar (SEARCH_SYMS autocomplete dropdown): typing a symbol opens `NewsDrawer` sliding panel with `buildNewsHistory()` categorized items (Catalyst, Technical, Sector, Analyst, Earnings, Calendar, Coverage, Product, Guidance). "Open full stock page →" button in NewsDrawer calls `openStockFull(sym)`. Remaining: WebSocket real-time data, pin/mark-read, push delivery. |
| F-61 | Commentary Quick News Lookup — Bottom Card + Context-Aware | MVP | Free+ | **Complete** | 100% | Full Stack | Permanent card at bottom of col-8 feed column (replaces sidebar position). Title switches: `activeTab === 3 ? "Tracked names" : "Quick news lookup"`. Chip list switches: My names tab shows `[...mySymbols]` chips (user's watchlist), all other tabs show 8 hardcoded ticker chips. General perspective card in col-4 has `flex: 1` so its bottom aligns with this card. Atomic subtasks: (1) remove standalone Quick news lookup from col-4; (2) add card below feed card in col-8; (3) wire activeTab condition for title/chips; (4) add flex:1 to General perspective. File: `screens/commentary.tsx`. |
| F-33 | Story Stocks Section | Phase 2 | Pro+ | **Not Started** | 0% | Full Stack | Curated section for stocks with active narrative. AI-tagged via news cluster density + price/volume anomaly. Card: what/why/what changed today/next catalyst date/affected peers+ETFs+sectors. |

---

## My Money

### Themes — `/menu/themes`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-64 | Themes Screen — Sector Theme Browser | MVP | Pro+ | **Complete** | 100% | Full Stack | 8 curated sector themes (e.g. AI Infrastructure, Biotech, Clean Energy). Left panel: StockListCard (340px) with read-only StockRow list per theme (no delete button → 3-column grid). Right: ChartCard for selected stock. Below: StockScreenEmbed for stock detail. Theme selector in card header. Atomic subtasks: (1) define THEMES[] module-level constant with 8 theme objects; (2) render StockListCard with theme name header; (3) wire theme selection to update stock list; (4) render StockRow without onDelete; (5) pass selectedSym to StockPanelLayout. File: `screens/themes.tsx`. |

---

## My Money

### Portfolio Pulse — `/menu/portfolio`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-13 | Portfolio Creation & Management | MVP | Free+ | **In Progress** | 65% | Full Stack | Left pf-list panel: holdings `useState` (add/partial sell/remove), seeded from mock data. Right panel: full StockScreen embedded via dynamic import for `pfSel` ticker — same layout as Stock Detail page. Clicking a holding row sets `pfSel`. Per-holding: current price, day change, position size bucket, G/L, next earnings date, last analyst action. Broker import Phase 2. File: `screens/portfolio.tsx`. |
| F-52 | AI Portfolio Summary — Drivers / Laggards / Leaders | MVP | Pro+ | **Complete** | 100% | Full Stack | Dynamic 3-column grid computed from `holdings` useState: Drivers (top G/L), Laggards (bottom G/L), Leaders today (top day change). Each row clickable → openStock(). AI disclaimer footer. Updates live as holdings are added/removed. **AI Pulse card added**: renders `PULSE` string array as bullet notes below the WMN block (before the holdings table) — each note is a plain-English AI insight for a specific holding, with disclaimer. File: `screens/portfolio.tsx`. |
| F-14 | Portfolio Pulse Card | MVP | Pro+ | **Not Started** | 0% | AI + Backend | AI summary generated at 7am ET + updated at market close. In plain English: what changed in holdings today and why. Flags names with material events (earnings, analyst action, unusual move). |
| F-37 | Broker Import (Plaid/SnapTrade) | Phase 2 | Pro+ | **Not Started** | 0% | Backend | Plaid or SnapTrade OAuth. Multi-brokerage support. Pull current positions, reconcile against manually entered portfolio. |

### Watchlist — `/menu/watchlist`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-15 | Watchlist Management | MVP | Free (5 max) | **In Progress** | 50% | Full Stack | Company name click opens `stock-side-drawer` with full embedded StockScreen (dynamic import). Delete confirmation modal: "Are you sure want to delete {sym}?" with OK/Cancel (state: `confirmDelete`). `localStorage("iq-watchlist")` persists list as JSON array of strings across sessions. Free: up to 5 names. Pro+: unlimited. File: `screens/watchlist.tsx`. |
| F-51 | AI Watchlist Alerts — Per-Stock Toggle | MVP | Pro+ | **Complete** | 100% | Full Stack | Two-panel Google Finance layout: left panel (280px, filter chips All/Options active/Movers today, scrollable wl-item list with sparklines), right panel (breadcrumb, company header with icon+price, area chart with period selector + toolbar, tabs Overview/Earnings/Analyst/Financials, metrics table). `bigChartSVG()` generates 800×160 SVG area chart seeded from ticker. CSS: `.wl-*` classes in iq.css. File: `screens/watchlist.tsx`. |
| F-16 | Alert Engine — Core Rules | MVP | Pro+ | **Not Started** | 0% | Backend | In-app + email (Phase 1); SMS + push Phase 2. 12 alert types: earnings posted, post-ER move >5%, analyst up/down, unusual options, block trade, price move, volume spike >3×, 52-wk breakout, macro event, peer sympathy move, 13F filing, group RS rank. |
| F-38 | Industry Rotation Alerts | Phase 2 | Premium | **Not Started** | 0% | Backend | Detection: industry subgroup enters or exits top 20 RS rankings. Push + email delivery. |

---

## Context

### Recaps — `/menu/recap`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-22 | End-of-Day Recap | MVP | Free (read) | **In Progress** | 80% | AI + Backend | EOD tab complete: `RcpIndexCards` (9-index pulse grid, `data.pulse`, `Spark` sparklines); `NewsBriefing` newspaper two-page spread (`NEWS_DAILY` array, `DAILY_LEAD`, `stockifyText()` inline ticker parsing, social share buttons X/LinkedIn/WhatsApp/Facebook/Telegram); `ScheduleShare` form (freq/time/email — demo state); recap-hero (headline + index returns + audio CTA), PDF download, 2-col key stories + up-next, sector heatmap, earnings movers, market internals. File: `screens/recap.tsx`. Remaining: real backend generation, actual PDF writer, audio TTS, email delivery. |
| F-23 | Weekly Recap | MVP | Free (read) | **In Progress** | 60% | AI + Backend | "This Week" tab shares the same `RcpIndexCards`, `NewsBriefing` (using `NEWS_WEEKLY` / `WEEKLY_LEAD`), and `ScheduleShare` components as EOD. Static `WEEKLY` data: headline, 5-day index returns, top-stories + next-week calendar (2-col), sector leaders/laggards/biggest-moves (3-col), weekly sector heatmap. File: `screens/recap.tsx`. Remaining: real backend weekly generation, portfolio-specific weekly tab. |
| F-34 | Audio Recaps (TTS) | Phase 2 | Premium | **Not Started** | 0% | Backend | TTS pipeline: Claude generates 60s audio script from EOD/weekly recap → TTS → MP3 stored in S3 → in-app player. |
| F-39 | Social Sharing — Recap Cards | Phase 2 | Pro+ | **In Progress** | 40% | Full Stack | Share buttons (X, LinkedIn, WhatsApp, Facebook, Telegram) implemented in `NewsBriefing` component via `window.open()` with platform-specific URL encoding. Remaining: recap card image generation (Canvas/Puppeteer), actual image attachment to share payloads. |

### Macro & VIX — `/menu/macro`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-20 | VIX Widget | MVP | Free+ | **Not Started** | 0% | Full Stack | VIX level + day change, 12-month percentile rank, trend direction (rising/falling/flat), plain-English explanation, 30-day sparkline trend. |
| F-21 | Macro Dashboard & Calendar | MVP | Pro+ | **In Progress** | 60% | Full Stack | Typed `MacroEvent` interface. 3-week calendar via `CAL_LAST`, `CAL_THIS`, `CAL_NEXT` arrays. 15+ events: CPI, PPI, Retail Sales, FOMC Decision, FOMC Press Conference, Jobless Claims, Philadelphia Fed, Existing Home Sales, GDP, PCE Deflator, Consumer Confidence, Durable Goods, Chicago PMI. 8-column table: Event, Date, Impact (H/M/L pill), Prior, Est., Actual, Surprise, Note. Market regime label widget: 7 states. Recent macro releases section. File: `screens/macro.tsx`. |

---

## Platform & Shell

### Shell & Design System

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-42 | MarketCatalyst Shell & Design System | MVP | All | **Complete** | 100% | Full Stack | IQShell wrapping each page; sidebar nav (3 groups: Intelligence / Context / My Money; 15 screens — Intelligence: Dashboard, Earnings, Market Movers, Heatmap, Analyst, Screener, IPOs, Stock Detail, Options, Insider & Institutional; Context: Commentary, Recap, Macro; My Money: Portfolio Pulse, Watchlist, Themes). Topbar (MarketCatalyst logo gradient + wordmark b=ai color), drawer system (stock/earnings/sector/fund/index/feargreed), AI Copilot panel, Cmd+K palette, profile dropdown. IQActionsContext: openStock/openStockFull/openEarnings/openSector/openFund/openIndex/openFearGreed/setCopilot/theme/setTheme. **Modal pattern (iq.css)**: all overlay UIs use `position:fixed; inset:0; margin:auto` centered modal with `iq-popIn` scale+translateY animation, replacing the prior right-side sliding drawer. Mobile responsive: `@media (max-width: 767px)` breakpoint. Hamburger (`.mob-ham`), slide-in rail (`.rail.mob-open`), scrim inside `.app` (critical stacking context fix — scrim z-100, rail z-200). Bottom-sheet drawers on mobile. Options page: horizontal tab scroll, header meta wraps. Nav items `var(--text-hi)` in rail. Tablet `@media (max-width: 860px)` stacks options sidebar. Profile dropdown: `iq-dropdownIn` animation (no translateX), `pd-avatar` 52px image in popup header. |
| F-58 | Shared Stock Panel Components (`stock-panel.tsx`) | MVP | All | **Complete** | 100% | Full Stack | Central shared component file at `app/iq/stock-panel.tsx`. Eliminates duplication of `StockScreenEmbed`, trash icon, row, card, chart, and layout components across 4 screens (watchlist, portfolio, themes, screener). Exports: `StockScreenEmbed` (dynamic import — one definition for all screens; shell.tsx keeps its own local copy to break its own circular chain), `StockRow` (pf-li grid row — 4-col with delete, 3-col without), `StockListCard` (340px flex column card with scrollable pf-list + headerRight slot), `ChartCard` (flex-1 card with TF toolbar ["1D","1W","1M","3M","6M","1Y","5Y"] + CandleChart), `StockPanelLayout` (top flex row with alignItems:stretch + StockScreenEmbed below). Atomic subtasks: see T-133a through T-133e in task tracker. **2026-07-22 fix:** `ChartCard` (and the embedded chart in `StockScreenEmbed`) called `CandleChart` **without** `realBars`, so every chart on **Watchlist, Portfolio, Themes and Screener was 100% synthetic** — a seeded random walk — even though real bars existed in Firestore. Both call sites now pass `realBars={useChartBars(sym, tf)}`. See F-66. |
| F-66 | Real Chart Bars — All 7 Timeframes | MVP | Free+ | **Complete** | 100% | Full Stack | `app/iq/hooks/useChartBars.ts` supersedes the daily-only `useOhlcvBars`, which served only 3M/6M/1Y and returned `null` for 1D/1W/1M/5Y (the chart then fell back to a seeded random walk). Routing: **1D** → `intraday_bars/{ticker}_5min` (1 session), **1W** → `_5min` (5 sessions), **1M** → `intraday_bars/{ticker}_30min` (22 sessions), **3M/6M/1Y/5Y** → `ohlcv_bars` daily, limited to 64/128/252/1300 bars. Two enablers: the new `intraday-bars.job.ts` (one doc per ticker/resolution holding an array of bars — not a doc per bar), and `stock-history.job.ts` backfill raised 300 days → **5 years**. The constant raise alone did nothing: `lastSyncedThrough` only ever advances, so an `earliestSyncedFrom` watermark was added to let history fill **backwards** as well as forwards, clamped to the Polygon plan's rolling 5-year edge. Bars now also persist `vwap`. **LIVE** — pure Firestore reads, no backend call. Populated: `intraday_bars` 474 docs. Caveat: data is refreshed only by manual job runs (no Cloud Scheduler — see header note). |
| F-44 | User Preferences & Dark Mode | MVP | All | **Complete** | 100% | Full Stack | Dark mode toggle in Settings wired to Firestore `settings/{uid}` (darkMode: boolean). Custom in-app confirmation modal. Theme applied via `data-theme` on `.iq-root`. localStorage fast cache (no flicker on nav). Firestore read on shell mount syncs across devices. |
| F-40 | Cmd+K Command Bar | Phase 2 | Pro+ | **In Progress** | 65% | Full Stack | Cmd+K / Ctrl+K global overlay. `SEARCHABLE_STOCKS` constant (20 tickers with name/sector). Stock ticker results surface above page-nav results. Per-stock ☆/★ star toggle with `starred: Set<string>` state and `toggleStar(sym)`. Starred stocks listed in palette footer section. Keyboard navigation (↑↓ arrows, Enter, Escape). Phase 2: fuzzy search via API, contextual suggestions by current page. File: `shell.tsx`. |
| F-32 | AI Market Copilot (Chat) | Phase 2 | Premium | **Not Started** | 0% | AI + Full Stack | Chat panel in shell. Access to: live market data, earnings, analyst actions, 13F, macro, portfolio, watchlist. Streaming SSE. Labeled informational, not investment advice. |
| F-24 | Learn in 60 Seconds | MVP | Free+ | **Not Started** | 0% | Full Stack | Contextual educational micro-cards triggered by page landing. Examples: 13F page → "What is a 13F?"; earnings detail → "Why guidance matters more than EPS"; VIX widget → "What VIX levels mean". |

### Subscription & Billing

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-25 | Subscription & Billing (Stripe) | MVP | N/A | **In Progress** | 35% | Full Stack | Split into two halves. **Entitlement half — DONE (see F-67/F-68):** plans, tiers, entitlement keys, gates and upgrade panels all exist. **Payment half — NOT BUILT:** there is **no Stripe code in either repo** — no SDK dependency, no checkout session, no webhook handler, no customer/price IDs. The `payments` and `subscriptions` Firestore collections exist with rules but are **empty**. Checkout and webhooks are additionally blocked on the browser→backend gap (header note): a Stripe webhook needs a publicly reachable backend endpoint, and Firebase Hosting rewrite → Cloud Run **requires** setting `ADMIN_GUARD_TRUST_IAM=false` first or `/sync/:job/run`, `/purge` and `/retention` become world-callable. Note the tier names in this doc predate the shipped plans: shipped ids are **free / plus / pro**, not Free/Pro/Premium. |
| F-67 | Plans & Entitlements Registry | MVP | All | **Complete** | 100% | Full Stack | New backend module `src/plans/`. `plans.registry.ts` defines **30 entitlement keys** and 3 plans; `plans.service.ts` seeds/reads the `plans` collection **merge-based so operator edits survive re-seeding**; `subscriptions.service.ts` resolves the effective subscription — **expiry is computed, never trusted**, because nothing rewrites a user doc when a subscription lapses — and falls back to FREE, never to no-access. `plans.controller.ts`: `GET /plans`, `POST /plans/seed` (admin), `GET /users/:uid/entitlements`. Plans live in Firestore: `free` $0 no cycle 8/30 · `plus` 2999 USD monthly 20/30 · `pro` 4999 USD monthly 28/30. **Amounts are minor units (cents)** — 4999 = $49.99. Cumulative ladder — Free: marketCatalyst, news, scanner, heatmap, macro, ipos, chartsDaily, watchlist; Plus adds chartsIntraday, chartsHistory, chartIndicators, chartNotes, technicalRatings, dividendHistory, peers, earningsDetail, portfolio, screener, themes, alerts; Pro adds fundamentalRatings, ownership, optionsChain, exportData, apiAccess, aiAssistant, backtesting, paperTrading. `adminDashboard` + `userManagement` are **staff-only and false on every plan** (selling them would be privilege escalation) — which is why Pro is 28/30, not 30/30. Frontend: `app/iq/entitlements.tsx` (`EntitlementProvider`, `useSubscription`, `useEntitlement`, `EntitlementGate`, `formatAmount`) and `app/iq/entitlement-gate.tsx` (`PlanGate` upgrade panel, `useSlugEntitled` to hide nav items, `SLUG_ENTITLEMENT` map). |
| F-68 | Two-Layer Gating — Release Flags × Plan Entitlements | MVP | All | **Complete** | 100% | Full Stack | Deliberately **two** independent layers that must not be merged. **FF_\* release flags** (`feature-flags.registry.ts`) answer *"is it built and shipped?"*; **plan entitlements** (`plans.registry.ts`) answer *"may this tier use it?"*. A feature is usable only when both are true, and they render **different** UI — "coming soon" vs "upgrade to unlock". Merging them would make an unbuilt feature look like a paywall. Concrete case: `backtesting` and `paperTrading` are **granted on Pro but NOT BUILT**, so they correctly show "coming soon", not an upsell. |

### Mobile & Platform Expansion

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-36 | Mobile App (React Native) | Phase 2 | Pro+ | **Not Started** | 0% | Mobile | React Native. Bottom tab nav: Dashboard / Earnings / Movers / Portfolio / Alerts. Push notifications for all alert types. Condensed mobile-optimized views. Shared API layer with web. |
| F-56 | Web App Mobile Responsive | MVP | All | **Complete** | 100% | Full Stack | Responsive shell at ≤767px: hamburger menu (`.mob-ham`), slide-in nav rail (`.rail.mob-open`), scrim inside `.app` for correct stacking context, bottom-sheet drawers, icon-only Copilot FAB. Tablet breakpoint at ≤860px for options sidebar. Auth pages responsive: `lp-auth-cols` / `lp-auth-left` / `lp-auth-form` classes, ≤600px hides marketing panel. Options page: tabs scroll horizontally, stock header wraps on mobile. Profile dropdown: fixed shift bug (`iq-dropdownIn`), 52px avatar image. Firebase Auth iOS Safari: popup-first + redirect fallback + `indexedDBLocalPersistence`. |

---

## Admin & Operations

> Staff-only surfaces. Reached at `/admin` (`app/admin/page.tsx`), which builds
> the console dataset from Firestore in `app/admin/admin-data.ts` and stages it
> in `sessionStorage` **before** the iframe mounts, then embeds
> `public/admin/console.html`. The iframe has no Firebase SDK of its own — it
> reads the staged dataset and posts writes back to the host page.
> Access control: Firestore `isAdmin()` = `token.admin == true` **OR**
> `token.email == ADMIN_EMAIL`. It deliberately does **not** require
> `email_verified` — the admin is a password account with `emailVerified=false`,
> and requiring it locked the admin out of Firestore while the backend guard
> still admitted the same account.
> **Staff accounts are excluded from every metric** in every view below.

### Admin Console — `/admin`

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-69 | Admin Console — Real Data Pipeline | MVP | Staff | **Complete** | 100% | Full Stack | `public/admin/console.html` previously rendered entirely mock data. It now renders **real** Firestore data staged by `app/admin/admin-data.ts`. Fabricated affordances are **suppressed whenever real data is present**: the trend delta chips ("+12% vs last month") and the fake MRR history chart no longer render, because there is no historical series behind them (`revenue_summary` is empty). Views: Overview, Users, Subscriptions, Revenue, Usage & API, Monitor, Social Studio. **LIVE** for everything Firestore-backed; see F-73 for the one view that is not. |
| F-70 | Admin — Users | MVP | Staff | **Complete** | 100% | Full Stack | `data-view="users"`. Backed by `GET /admin/users` (`admin-analytics.service.ts` / `admin-analytics.controller.ts`, admin-guarded) and by direct Firestore reads of `users` (rule: owner **or** admin read). Lists accounts with plan, signup date and status. **⚠ Engagement columns — watchlists / holdings / apiCalls / alerts per user — display 0.** There is no collection behind them yet; the columns are wired but unpopulated, not broken. |
| F-71 | Admin — Subscriptions (reordered layout) | MVP | Staff | **Complete** | 100% | Full Stack | `data-view="subs"`. Layout was **reordered so operational urgency comes first**: (1) **Needs attention · failed payments** (dunning queue; count mirrored into the `dunBadge` nav badge), then (2) **Renewing soon** (next 15 days — a subscription appears once its expiry date enters the horizon), then (3) the **plan cards**. Rationale: plan cards are reference data and never need acting on, whereas the first two rows are work queues. Backed by `GET /admin/subscriptions`. **Currently both queues are empty** — the `subscriptions` and `payments` collections have no documents because Stripe is not implemented (F-25). |
| F-72 | Admin — Per-Plan Feature Editor | MVP | Staff | **Complete** | 100% | Full Stack | Inside the Subscriptions view. Renders all **30 entitlement keys** from the `CATALOG` for each plan with an on/off toggle and an "N of 30 enabled" count. Toggles write optimistically to `plans/{id}.featureFlags` and **revert on failure**. The 2 **staff-only** keys (`adminDashboard`, `userManagement`) render with a `staff only` badge and are **locked — not togglable** on any plan. Firestore rule enforces the same boundary server-side: an admin may update **`featureFlags` + `updatedAt` only**; `amount`, `currency` and `cycle` are server-only (a client that could rewrite `amount` could set a plan to $0), and plan create/delete is denied outright. |
| F-73 | Admin — Revenue | MVP | Staff | **In Progress** | 50% | Full Stack | `data-view="revenue"`. Backed by `GET /admin/revenue`. The view and aggregation are built and correct, but every figure resolves to **0 / empty**: `payments`, `subscriptions` and `revenue_summary` are all empty collections, and the MRR history chart is suppressed rather than faked. **Becomes meaningful only once F-25 (Stripe) lands.** |
| F-74 | Admin — Usage & API (feature adoption) | MVP | Staff | **In Progress** | 55% | Full Stack | `data-view="usage"`. Two halves with **different** statuses. **Feature adoption — LIVE:** reads the `feature_adoption` collection (~12 rows seeded) written by F-75. **API usage — NOT BUILT:** `api_usage` is specified, has Firestore rules, and has a collection, but **no middleware records API calls anywhere in the backend**, so every API KPI on this view reads 0. Do not read those tiles as "no traffic"; read them as "not instrumented". |
| F-75 | Admin — Monitor (backend ops UI) | MVP | Staff | **In Progress** | 70% | Full Stack | `data-view="monitor"`. New nav item that embeds the existing backend ops dashboard (per-job Firestore collection / cron schedule / next-run tracking, manual "run all jobs" trigger). Loaded **lazily on first visit** to the tab (`renderMonitor()`), so the console does not pay for it on every load. **BUILT — NOT REACHABLE IN PROD:** the ops UI is served by the backend, which the browser cannot reach (`NEXT_PUBLIC_BACKEND_URL` unset → `http://localhost:4400` baked into the production bundle → blocked as mixed content). Works locally. This is the single largest visible casualty of that gap. |

### Cross-Cutting Capabilities

| ID | Feature | Phase | Tier | Status | % | Owner | Notes |
|---|---|---|---|---|---|---|---|
| F-76 | Feature Adoption Tracking | MVP | All | **Complete** | 100% | Full Stack | `app/iq/feature-adoption.ts` + `app/iq/track-feature.tsx`. **48 tracked features**: every screen in `menuItems` plus in-app actions — the 8 Stock Detail drawers, chart timeframe / indicator / expand interactions, watchlist add & remove, search, screener, news, and others. **30-second dedupe** per feature so a user toggling a tab does not inflate counts. **Failures are swallowed** — analytics can never break a screen. Writes go **client → Firestore directly**, deliberately: `feature_adoption` is the **only client-writable analytics collection**, precisely because the browser cannot reach the backend. Rules constrain it tightly: the row must belong to the caller, `openCount` may only **increase**, ownership cannot change, delete denied. Feeds F-74. |
| F-77 | Firestore Rules — Analytics & Billing Collections | MVP | All | **Complete** | 100% | Backend | New collections: `intraday_bars`, `dividend_history`, `splits`, `plans`, `payments`, `subscriptions`, `feature_adoption`, `api_usage`, `audit_logs`, `revenue_summary`, `system_metrics`. Populated: intraday_bars 474, dividend_history 241, splits 241, plans 3, feature_adoption ~12. **Empty:** payments, subscriptions, api_usage, audit_logs, revenue_summary, system_metrics. Access: `payments`/`subscriptions` — admin reads all, a user reads only their own; `api_usage`/`feature_adoption`/`audit_logs`/`revenue_summary`/`system_metrics` — admin read only (plus the constrained client write on `feature_adoption`, F-76). **Two pre-existing bugs fixed:** `market_sentiment` and `stock_comments` had **no rule at all**, so default-deny silently blocked the Dashboard Fear & Greed gauge (which fell back to a hardcoded 62 / "Greed") and the chart-notes feature (F-50). **⚠ Both repos ship a `firestore.rules`; they have DRIFTED.** The **live** ruleset is deployed from `MarketCatalystUI/firestore.rules`. The backend copy is stale and now carries a DO-NOT-DEPLOY header. |

---

## Known Gaps — Fabricated or Unbuilt

Explicit inventory of what is still **not real**, so no reader mistakes UI polish
for a working feature.

| Area | State | Detail |
|---|---|---|
| AI narratives | **NOT BUILT** | Every AI surface renders hand-written static prose: AI Technical Analysis (F-31), AI Earnings Summary (F-06), Portfolio Pulse card (F-14), AI Market Copilot (F-32), Story Stocks (F-33), AI note per analyst action (F-12), the AI "read" in the earnings inline panel (F-49), and the AI Pulse bullets in F-52. **No Claude API call exists in either repo.** |
| Backtesting | **NOT BUILT** | Entitlement key granted on Pro; no implementation. Renders "coming soon" via F-68, not an upsell. |
| Paper trading | **NOT BUILT** | Same as above — Pro entitlement, no implementation, "coming soon". |
| Alerts engine | **NOT BUILT** | `alerts` is a Plus entitlement and F-16 lists 12 alert types, but there is no rules engine, no evaluation job, and no delivery path (in-app, email, SMS or push). The per-stock alert toggle in F-51 is UI state only. |
| Stripe / payments | **NOT BUILT** | No Stripe code in either repo. `payments` and `subscriptions` empty. Blocked additionally on the browser→backend gap. See F-25. |
| `api_usage` | **SPECIFIED, NOT IMPLEMENTED** | Collection + rules exist; no middleware records anything. Admin "Usage & API" KPIs read 0. See F-74. |
| Per-user engagement counts | **NO SOURCE** | watchlists / holdings / apiCalls / alerts columns in Admin → Users render 0; no backing collection. See F-70. |
| Options greeks / IV / OI / bid-ask | **VENDOR-BLOCKED** | Hard 403 `NOT_AUTHORIZED` on the Polygon options snapshot endpoint. Values shown are seeded pseudo-random. Also unavailable on this plan: index values (I:SPX, I:VIX), trades/quotes/last-trade, Benzinga endpoints, `/v1/summaries`; 404 on short-interest and futures. Measured plan limits: **exactly 900 s (15 min) delay**, **exactly 5-year rolling history**. |
| Automated data refresh | **NOT DEPLOYED** | No Cloud Scheduler jobs in any region and no `scheduler-invoker` service account — `create-scheduler-jobs.sh` was never run. With `min-instances=0` the in-process `@Cron` decorators never fire. **No sync job has ever run automatically in production.** |
| Backend reachable from browser | **NOT DEPLOYED** | `NEXT_PUBLIC_BACKEND_URL` unset → `http://localhost:4400` in the production bundle, blocked as mixed content. Disables Monitor (F-75), extended-hours moves and the vendor market-status pill (F-65), and any future Stripe checkout/webhook. Fix = Firebase Hosting rewrite → Cloud Run, which **requires** `ADMIN_GUARD_TRUST_IAM=false` first, or `/sync/:job/run`, `/purge` and `/retention` become world-callable. |
| `POLYGON_API_KEY` | **UN-ROTATED** | Key was exposed in chat and has not been rotated. Secret Manager version 4 is enabled. `deploy/rotate-polygon-key.sh` automates everything except generating the replacement key. |

---

## Phase Summary

Recounted from the tables above on 2026-07-22 (the previous version of this
table did not reconcile with its own rows). Counts include the 13 features
added in v1.4 (F-65 – F-77) and the `*(F-01)*` Heatmap sub-row.

| Phase | Total Features | Complete | In Progress | Not Started | Target |
|---|---|---|---|---|---|
| MVP (Phase 1) | 59 | 27 | 19 | 13 | Week 18 |
| Phase 2 | 16 | 0 | 3 | 13 | Week 38 |
| **Total** | **75** | **27** | **22** | **26** | — |

New in v1.4: F-65 (extended hours/market status), F-66 (real chart bars),
F-67 (plans & entitlements), F-68 (two-layer gating), F-69 – F-75 (admin
console + its six views), F-76 (feature adoption), F-77 (Firestore rules).

## Status Legend

| Status | Meaning |
|---|---|
| Not Started | Work has not begun |
| In Progress | Actively in development (UI built with static data counts) |
| In Review | Dev complete; in QA or stakeholder review |
| Complete | Deployed and accepted |

### Deployment annotation (added 2026-07-22)

Because a feature can be finished and still be unusable in production, Notes
carry an explicit deployment marker. **Status ≠ reachability.**

| Marker | Meaning |
|---|---|
| **LIVE** | Works in production today. In practice this means "reads Firestore directly" — those paths need no backend call. |
| **BUILT — NOT REACHABLE IN PROD** | Code is complete and works locally, but the production bundle cannot reach the backend (`NEXT_PUBLIC_BACKEND_URL` unset). Affects F-65 and F-75. |
| **NOT BUILT** | No implementation exists, regardless of how finished the UI looks. See *Known Gaps — Fabricated or Unbuilt*. |
| **VENDOR-BLOCKED** | Implementation exists but the data is not obtainable on the current Polygon plan (403/404). Not a build gap. |
