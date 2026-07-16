**MarketCatalyst — Market Intelligence Terminal**

System Architecture Document \| v1.1 \| June 2026

> **⚠ Implementation status (updated 2026-07-09, first noted 2026-07-05):**
> This document describes the originally proposed 5-layer architecture (ECS
> workers, ClickHouse, Redis, BullMQ, Fastify REST + WebSocket gateway). The
> actual implementation is a single NestJS service (`backend/`) with
> scheduled cron jobs (`@nestjs/schedule`) writing directly to Firestore —
> no ClickHouse, Redis, BullMQ, WebSocket gateway, or Fastify exist in the
> real stack, and there is no REST API exposed to the frontend (the Next.js
> app reads Firestore directly via the client SDK). Vendor calls go through
> a small adapter layer (`backend/src/adapters/`) with automatic fallback
> between two vendors each for company profiles, market movers, mover
> enrichment, and (added 2026-07-08) news — not described here at all.
> Client-owned data (watchlists, portfolio holdings, and — added
> 2026-07-08 — a materialized portfolio-totals summary) is written directly
> by the Next.js app via the Firestore client SDK, never through the
> backend, since `firestore.rules` already scopes those paths to
> `isOwner(uid)`. Also not described here: Firestore composite indexes are
> declared in a `firestore.indexes.json` (added 2026-07-08, deployed via
> `firebase deploy --only firestore:indexes`) alongside `firestore.rules`;
> and every sync job now declares its own Firestore collection(s) + cron
> schedule once at registration (`SyncRegistry` in `backend/src/common/`,
> deliberately placed in the `@Global()` `CommonModule` rather than
> `SyncModule` so `SyncMetaService` can inject it without a circular module
> import) — persisted into `sync_meta` on every run and exposed via
> `GET /sync/jobs`/`POST /sync/run-all`, an ops-only dashboard
> (`backendUI/index.html`), not a MarketCatalyst feature. See `Doc/openapi.yaml`
> for the real data contract (documented as REST for portability, even
> though it's actually served via Firestore reads), `Doc/screen-data-sources.md`
> for the most current per-screen breakdown, and `backend/src/` for the real code.

1\. Architecture Overview

The platform is a multi-tier, event-driven web application built around a real-time data ingestion pipeline, a REST + WebSocket API layer, a React single-page application, and a set of AI generation workers. The architecture prioritizes low-latency data delivery, horizontal scalability of stateless API nodes, and clean separation between the ingestion, storage, serving, and presentation layers.

2\. High-Level System Diagram (Textual)

**Data flows left to right through five layers:**

+--------------------------------------------------------+---+------------------------------------------------------+---+------------------------------------------------------------------------+---+--------------------------------------------------------------------------+---+--------------------------------------------------------------------------+
| **External Data Vendors**                              | → | **Ingestion Workers**                                | → | **Data Store**                                                         | → | **API Layer**                                                            | → | **Client**                                                               |
|                                                        |   |                                                      |   |                                                                        |   |                                                                          |   |                                                                          |
| Polygon, FMP, Benzinga, Unusual Whales, EDGAR, Finnhub |   | Python workers + WebSocket connectors + EDGAR parser |   | Firestore (domain data), ClickHouse (time-series), Redis (cache + pub/sub) |   | Fastify REST API, WebSocket gateway, BullMQ workers, AI generation queue |   | React SPA (Vercel), WebSocket subscription manager, mobile app (Phase 2) |
+--------------------------------------------------------+---+------------------------------------------------------+---+------------------------------------------------------------------------+---+--------------------------------------------------------------------------+---+--------------------------------------------------------------------------+

3\. Layer Specifications

3.1 Data Ingestion Layer

All external data is normalized into internal schemas before storage. Workers run as separate ECS tasks to isolate blast radius.

  ------------------------ --------------------- ----------------------- ----------------------------------------------
  **Worker**               **Source**            **Frequency**           **Writes To**
  Quote Ingestion          Polygon.io WS         Real-time (streaming)   ClickHouse quotes table, Redis quote cache
  News Ingestion           Benzinga REST + WS    Real-time               Firestore news collection, Redis pub/sub channel
  Earnings Calendar Sync   FMP REST              Every 15 min            Firestore earnings\_events collection
  Analyst Actions Ingest   Benzinga REST         Every 5 min             Firestore analyst\_actions collection
  Macro Calendar Sync      Finnhub REST          Daily at 6am ET         Firestore macro\_events collection
  Options Flow Ingest      Unusual Whales WS     Real-time               Firestore options\_flow collection
  EDGAR 13F Parser         SEC EDGAR full-text   Nightly + on filing     Firestore fund\_holdings collection
  Block Trade Ingest       Polygon.io Trades     Real-time               Firestore block\_trades collection
  ------------------------ --------------------- ----------------------- ----------------------------------------------

3.2 Data Storage Layer

Firestore (Primary Document Store)

-   Stores all structured domain data as document collections: users, portfolios, watchlists, earnings\_events, analyst\_actions, news, fund\_holdings, alerts, notifications, 13F data

-   Document IDs use Firebase-generated IDs (or ticker/userId as natural keys where appropriate); soft deletes via deletedAt field

-   Compound queries use Firestore composite indexes (defined in firestore.indexes.json); no read replicas needed — Firestore scales horizontally by default

-   Firebase Admin SDK used server-side (Node.js) for all reads/writes; Firestore security rules enforce collection-level access control

ClickHouse (Time-Series Store)

-   Stores OHLCV quotes, intraday tick data, volume history, and market movers snapshots

-   Partitioned by date; ReplacingMergeTree for deduplication of real-time ticks

-   Query interface exposed via an internal microservice (never queried directly from API)

Redis

-   Live quote cache: key = ticker, TTL = 5 seconds

-   Pub/Sub: channels per feed type (news, analyst\_actions, earnings, movers) --- API gateway subscribes and fans out to WebSocket clients

-   Session store for authenticated WebSocket connections

-   BullMQ job queues for async workers (AI generation, alert dispatch, recap generation)

S3

-   Audio recap files (mp3), earnings call recordings (if sourced)

-   Recap card images for social sharing (Phase 2)

-   CSV export downloads

3.3 API Layer

REST API (Fastify / Node.js)

-   Versioned at /api/v1/. Authenticated via Firebase ID tokens (verified with Firebase Admin SDK)

-   Rate limits: Free = 60 req/min, Pro = 300 req/min, Premium = 600 req/min

-   All endpoints return JSON; paginated lists use cursor pagination

-   Deployed as ECS Fargate tasks behind an Application Load Balancer; auto-scales on CPU \> 60%

WebSocket Gateway

-   Separate Fastify server running ws:// upgrade handler

-   Client authenticates via Firebase ID token on connection; server verifies with Admin SDK and maps socket to user session

-   Client subscribes to named channels: feed:all, feed:portfolio:{userId}, movers:live, quotes:{ticker}

-   Messages are JSON with schema: { type, channel, data, timestamp }

-   Horizontal scaling via Redis pub/sub fan-out; each gateway node subscribes to all channels and filters per connected client

AI Generation Workers (BullMQ)

-   earnings\_summary queue: triggered on earnings\_event.result\_posted; calls Anthropic Claude API with transcript + metrics; stores result in Firestore earnings\_summaries collection

-   ta\_analysis queue: triggered on user request; calls Claude with OHLCV + indicators; returns to client via REST response

-   recap\_generation queue: cron at 4:30pm ET (EOD) and Friday 6pm ET (weekly); Claude summarizes day/week from structured data

-   13f\_summary queue: triggered on new 13F ingestion; Claude summarizes changes per fund

-   copilot queue: real-time; user message + context injected, Claude responds with source citations story\_stocks queue: event-driven; triggered by news cluster density detector + price/volume anomaly worker; Claude evaluates and generates story card (what/why/catalyst date/peer impact); auto-published to story\_stocks table

3.4 Alert Engine

-   Alert rules stored in Firestore (users/{userId}/alerts sub-collection) with type, threshold, delivery\_channels, and enabled flag

-   Event processor subscribes to Redis pub/sub channels and evaluates all active rules matching the event type

-   On match: publishes to alert\_dispatch BullMQ queue; worker sends email (SendGrid) and in-app notification

-   In-app notifications stored in Firestore (users/{userId}/notifications sub-collection) with read/unread state

-   Phase 2: SMS via Twilio, push via FCM/APNs

3.5 Frontend Architecture (Next.js — Current Implementation)

Framework & Build

-   **Next.js 16.2.9 (App Router)** with TypeScript. Output mode: `static export` (`next build` → `out/` directory). Deployed to **Firebase Hosting** (not Vercel). 24 static routes pre-rendered as HTML.

-   All IQ screens are client components (`"use client"`). Server components are only used for the root layout.

-   Fonts loaded via `next/font/google`: Space Grotesk (display), Geist Sans (body), JetBrains Mono (monospace), Geist Mono.

State Management — Redux Toolkit

-   **Redux Toolkit** (`configureStore`) is the single source of truth for global app state. No Zustand, no React Query.

-   **`store.ts`**: combines two slices — `auth` and `profile`.

-   **`auth-slice.ts`**: holds `SerializedUser | null` (uid, email, displayName, photoURL) and `status: "loading" | "ready"`. Firebase `User` object is serialized before dispatch (Firebase objects are not Redux-serializable).

-   **`profile-slice.ts`**: holds `StoredProfile | null` (InvestorProfile fields + uid + tier) and `status: "idle" | "loading" | "ready"`. Firestore Timestamps are stripped before dispatch.

-   **`firebase-listener.tsx`** (`FirebaseListener` component): mounts inside `ReduxProvider`, calls `firebaseAuth.authStateReady()` then subscribes to `onAuthStateChanged`. On user sign-in, dispatches `setUser` and fetches `users/{uid}` from Firestore to dispatch `setProfile`. Runs once for the lifetime of the app.

-   **`redux-provider.tsx`**: wraps the app in `<Provider store={store}><FirebaseListener />{children}</Provider>` inside `app/layout.tsx`.

Error handling & monitoring (2026-07-12)

-   **Error boundaries**: `app/error.tsx` (route-segment) and `app/global-error.tsx` (root layout) — a thrown render/runtime error in a client component shows a recoverable fallback ("Try again" / reload) instead of a white screen, keeping the rest of the app alive. Both call `Sentry.captureException`.
-   **Sentry**: `app/sentry-init.tsx` (`SentryInit`, mounted in `app/layout.tsx`) inits `@sentry/browser`; the backend inits `@sentry/node` in `main.ts`. Both are **DSN-gated no-ops** until `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` are set.
-   **Backend resilience** (`backend/src/main.ts`): process-level `unhandledRejection`/`uncaughtException` handlers (log via Nest `Logger` + `Sentry.captureException`, do NOT exit — a failing sync job never takes the API down), plus `enableShutdownHooks()`. Pair with a supervisor (PM2) + the `/health` endpoint for clean restarts in prod.

-   **Typed hooks**: `useAppSelector` and `useAppDispatch` (from `store/hooks.ts`) wrap the RTK hooks with `RootState` and `AppDispatch` types.

Routing — Next.js App Router

-   `/` → **MarketCatalyst landing page** (marketing page, `app/page.tsx`). Animated dark background, full `hw-*` sections (hero, commitment, 5-step journey, 14 workspace cards, CTA). "Log in" opens an inline modal overlay (no navigation); "Sign up" navigates to `/auth/signup`.
-   `/auth/login` → Standalone login page (AuthLayout two-panel + LoginForm). Logo → `/`.
-   `/auth/signup` → Create Account (AuthLayout + SignupForm). "Sign in" link → `/`. Logo → `/`.
-   `/auth/forgot-password` → Password Reset (AuthLayout + ForgotForm). "Back to sign in" → `/`. Logo → `/`.
-   **AuthLayout mobile fix** (`app/auth/auth-layout.tsx`): classes `lp-auth-cols`, `lp-auth-left`, and `lp-auth-form` are now correctly applied to the JSX container elements, enabling the inline `<style>` media queries to take effect. At `≤900px` the two columns stack vertically; at `≤600px` the marketing panel (`lp-auth-left`) is hidden and the form card becomes full-width. Previously `lp-auth-cols` was absent from the JSX so the layout never collapsed on any device.
-   `/dashboard` → IQ Dashboard screen
-   `/menu/[slug]` → all MarketCatalyst screens (earnings, movers, heatmap, analyst, screener, ipos, portfolio, watchlist, stock, insider, commentary, recap, macro, manage-plan)
-   `/settings` → Settings screen
-   `/profile/edit` → Profile edit
-   Protected routes: all IQ routes guarded by `AuthGuard` component (checks Redux `state.auth.status === "ready"` and `state.auth.user`; redirects to `/` if not authenticated).

Auth Navigation Map

```
/ (landing)
  ├─ "Log in" btn      → inline modal (LoginForm, no route change)
  │    ├─ "Forgot?"    → /auth/forgot-password  →  "Back to sign in" → /
  │    └─ "Sign up"    → /auth/signup
  ├─ "Sign up" btn     → /auth/signup  →  success → /dashboard
  │    └─ "Sign in"    → / (landing)
  └─ Logo              → / (no-op, already on /)
/auth/login  (standalone)
  └─ Logo              → /
/auth/forgot-password
  └─ Logo              → /
```

MarketCatalyst Shell & Component Architecture

-   **`IQShell`** (`app/iq/shell.tsx`): the main authenticated shell. Wraps each page individually (not a Next.js layout). Contains the sidebar nav (3 groups: Intelligence / Context / My Money), topbar with "Stock**Wise**" branding, drawer system (stock/earnings/sector/fund/index/feargreed), AI Copilot panel, Cmd+K palette, and profile dropdown. Holds `theme` state and exposes it via `IQActionsContext`. **Mobile nav**: on `≤767px` the sidebar rail becomes `position:fixed; left:0; width:min(260px,80vw); transform:translateX(-100%)` and slides in when the `.mob-open` class is applied. New shell elements: `.mob-ham` (hamburger button in topbar), `.mob-brand` (logo in topbar), `.mob-rail-head` (rail header with close button), `.mob-nav-close`, `.mob-nav-scrim`. The scrim (`.mob-nav-scrim`, z-index 100) is placed **inside** the `.app` div so it shares `.app`'s stacking context with the rail (z-index 200) — prevents z-index bleed to unrelated layers.

-   **`IQActionsContext`**: React context providing `openStock(sym)`, `openStockFull(sym)`, `openEarnings(sym)`, `openSector(name)`, `openFund(idx)`, `openIndex(i)`, `openFearGreed()`, `setCopilot(open)`, `theme`, `setTheme` to all child screens. Consumed via `useIQActions()` hook.

-   **Drawer union type**: `drawer` state in IQShell is `{ type: "stock" | "earnings" | "sector" | "fund" | "index" | "feargreed" } | null`. `IndexDrawer` renders OHLC/day-range/52wk-range/AI-note for market indices, plus leading/lagging sectors for equity indices. `FearGreedDrawer` renders SemiGauge, 5-value history metric-grid, 7-component progress bars, AI read note.

-   **Theme system**: `theme: "dark" | "light"` state in `IQShell`. Applied as `data-theme={theme}` on `.iq-root` div. Initialized from `localStorage` synchronously (no flicker on navigation). Persisted to Firestore `settings/{uid}` collection (`darkMode: boolean` field) when user changes preference via Settings. `localStorage` acts as a fast cache so the correct theme is available on the first render of every page mount.

Shared Stock Panel Components (`app/iq/stock-panel.tsx`)

Created to eliminate duplication of stock list + chart + detail layout across watchlist, portfolio, themes, and screener screens. All four screens import from this file.

-   **`StockScreenEmbed`**: `dynamic(() => import("./screens/stock").then(m => ({ default: m.StockScreen })), { ssr: false })`. Single definition used by all 4 stock-list screens. **Exception**: `shell.tsx` retains its own local copy to avoid `stock.tsx → shell.tsx → stock.tsx` circular dependency.

-   **`StockRow`**: Renders a `pf-li` grid row. `gridTemplateColumns` is `"1fr 60px auto auto"` when `onDelete` is provided (4 cols including trash button), `"1fr 60px auto"` otherwise. Renders `<Spark>` sparkline and accepts `valueTop`/`valueBottom`/`valueBottomClass` for the price/change column.

-   **`StockListCard`**: Fixed 340px width flex-column card. Wraps a scrollable `pf-list` div. Accepts `headerRight` ReactNode slot and `isEmpty`/`emptyMessage` for empty state.

-   **`ChartCard`**: Flex-1 right panel. TF toolbar with buttons `["1D","1W","1M","3M","6M","1Y","5Y"]`. Renders `<CandleChart>` when `sym` is non-empty; empty-state centered text otherwise.

-   **`StockPanelLayout`**: Composes `listCard` prop + `<ChartCard>` in a flex row with `alignItems: stretch` (equal height). Below the row: `<StockScreenEmbed initialSym={selectedSym} hideHeader hideChart />` when a symbol is selected, or empty-state card. Props: `listCard`, `selectedSym`, `chartPx`, `tf`, `onTfChange`, `chartEmptyText?`, `detailEmptyText?`.

Shared Utility Components (`app/iq/utils.tsx`)

-   **`heatCol(p)`**: RGB color ramp matching HTML reference. Returns `{ bg, fg }`. Pale mint→deep green (positive), pale pink→deep red (negative). `fg` is `#ffffff` for dark tiles, `#0c1a13` for light tiles (threshold: saturation > 42%). Used by dashboard heatmap mini, heatmap treemap, and stock page key-stat cells.

-   **`CandleChart({ sym, tf, px, showMA?, showVol? })`**: SVG candlestick chart. Deterministic OHLC generation via seeded RNG matching HTML's `genOHLC()` algorithm. Features: candles + wicks, MA20/MA50 overlays, volume bars, ER marker, hover crosshair tooltip. `genOHLC` result is memoized via `useMemo([sym, tf, px])` — prevents recomputation on tooltip hover rerenders. Rendered on stock detail page and inside ChartCard.

-   **`RsiPane({ sym, tf })`**: SVG RSI oscillator sub-pane. 70/30 dashed reference lines. Shares seed with CandleChart so RSI is consistent with price data.

-   **`TrGauge({ val, size })`**: Segmented semicircle SVG (5 colored arcs: Strong Sell → Strong Buy) with animated needle. Used on stock Technical Rating card.

-   **`SemiGauge({ val, label, id })`**: Gradient arc SVG for Fear & Greed index (0–100). Used on dashboard F&G widget and FearGreedDrawer.

-   **`Spark({ seed, up })`**: Deterministic sparkline SVG. Used on pulse strip cards.

-   **`RATING_VAL`**: Map from rating string to gauge position — `{ "Strong Buy": 0.9, "Buy": 0.55, "Neutral": 0, "Sell": -0.55, "Strong Sell": -0.9 }`.

-   **`hashStr(s)`**: Exported deterministic string hash using `Math.imul(31, h)`. Used directly by `genOHLC` and `RsiPane`. The former `_hash` wrapper function has been removed — it was just `return hashStr(s)`.

-   **`EarnQ`**: Exported interface — `{ q: string; e: number; a: number; surp: number; mv: number }`. Used by stock.tsx, earnings.tsx, and commentary.tsx's `buildNewsHistory`.

-   **`earnHistory(sym, base)`**: Exported function returning 10-quarter deterministic EPS history. Formula: `(Math.abs(s.charCodeAt(0)*31 + (s.charCodeAt(1)||7)*17 + i*13) % 97) / 97`. Shared by stock.tsx, earnings.tsx, and commentary.tsx — eliminates three separate identical implementations.

Design System — MarketCatalyst (`iq.css`)

-   All styling is via a custom CSS design system in `app/iq.css`, imported globally in `app/layout.tsx`. Two mobile responsive breakpoints are defined: `@media (max-width: 767px)` (mobile) and `@media (max-width: 860px)` (tablet, options sidebar).

-   CSS custom properties on `:root` define the dark-mode palette (default): `--bg`, `--surface-0/1/2/3`, `--border`, `--border-soft`, `--border-strong`, `--text-hi`, `--text`, `--text-dim-solid`, `--brand`, `--brand-2`, `--brand-dim`, `--ai`, `--ai-2`, `--ai-dim`, `--up`, `--up-dim`, `--down`, `--down-dim`, `--warn`, `--warn-dim`, `--f-display`, `--f-body`, `--f-mono`, `--r-sm`, `--r`, `--r-lg`, `--r-xl`, `--shadow`.

-   `.iq-root[data-theme="dark"]` explicitly sets dark palette on the root element.

-   `.iq-root[data-theme="light"]` overrides with a light palette (`--bg: #EDF1F7` etc.).

-   Layout primitives: `.app` (CSS grid: sidebar + content; collapses to `grid-template-areas: 'topbar' 'ticker' 'main'` single-column on mobile), `.dash` (12-column content grid), `.col-3/4/5/6/7/8/12`, `.card`, `.card-h`, `.card-b`, `.page-head`, `.page-title`.

-   Component classes: `.wmn` (What Matters Now block), `.ai-block`, `.ai-sec`, `.heat` (sector heatmap grid), `.fundcard`, `.fin-row`, `.iq-toggle`, `.iq-toggle-row`, `.pill`, `.pill.up/dn/amc/opt/bmo/beat/miss/raise/lower/hold`, `.tr-badge`, `.iconbtn`, `.topbar-avatar`, `.pd-avatar` (52px circle for profile dropdown — shows photo or initials monogram), `.trseg`, `.trseg2`, `.tf-pills`, `.ind-tbl`, `.sd-grid`, `.sd-head`. Mobile-specific classes: `.mob-ham`, `.mob-brand`, `.mob-rail-head`, `.mob-nav-close`, `.mob-nav-scrim`, `.mob-open` (applied to rail to slide it in). `iq-dropdownIn` keyframe (`from { opacity:0; transform:scale(.95) } to { opacity:1; transform:scale(1) }`, `animation-fill-mode: both`) replaces `iq-scaleIn` for the profile dropdown to avoid the visual shift caused by the old `translateX(-50%)` that `iq-scaleIn` included.

-   Sliding drawer pattern: `.stock-side-drawer` — `position:fixed; right:0; top:0; height:100vh; width:min(680px,100vw); z-index:51; overflow:hidden auto`. Used by movers.tsx, watchlist.tsx, and portfolio.tsx to embed a full `StockScreen` without navigation. Header row uses `.drawer-h`; body uses `.drawer-b` (overflow auto, flex-grow). Paired with `.scrim` for click-away dismiss. On mobile (`≤767px`) drawers become bottom-sheets (`inset: auto 0 0 0; border-radius: top-xl`). Copilot FAB becomes an icon-only 48px circle on mobile. Options page expiry tabs scroll horizontally (`flex-wrap: nowrap; overflow-x: auto`) and header meta wraps below price. Nav items use `var(--text-hi)` in mobile drawer.

-   Stock screener classes: `.filt`, `.filt .fh`, `.filt .fb`, `.fgroup .fl`, `.preset`, `.dd`, `.dd-menu`.

-   Auth pages use the same CSS variables (imported globally) but are not wrapped in `.iq-root`; they use inline styles referencing `var(--*)`.

Screens (Current) — Navigation groups: Intelligence / Context / My Money

| Slug | Screen File | Nav Group | Status |
|---|---|---|---|
| dashboard | screens/dashboard.tsx | Intelligence | UI complete — session tabs removed; modal/popover pattern; Market Movers widget (Winners/Losers tabs, hover popup, sector/cap filters); Trending Stocks col-12 widget |
| earnings | screens/earnings.tsx | Intelligence | UI complete — side-by-side col-6 layout; inline accordion detail panel (no drawer) |
| movers | screens/movers.tsx | Intelligence | UI complete — row/pill click opens `stock-side-drawer` with embedded StockScreen (dynamic import); removed mvpop hover tooltip |
| heatmap | screens/heatmap.tsx | Intelligence | UI complete — heatCol() dynamic text color on treemap tiles |
| analyst | screens/analyst.tsx | Intelligence | UI complete — computeFlags() (5+ action alert); topUpgrades sidebar; ◆ AI take section full-width between signal cards and filter bar; rating table full-width (no col-8/col-4 split); static data |
| screener | screens/screener.tsx | Intelligence | UI complete — 20 presets, 9 checkbox filters live-wired (no submit), StockPanelLayout (340px results + ChartCard + StockScreenEmbed), auto-fallback stock selection |
| ipos | screens/ipos.tsx | Intelligence | UI complete — recent IPO table + upcoming pipeline tab; static data |
| stock | screens/stock.tsx | Intelligence | UI complete — CandleChart (useMemo genOHLC), RsiPane, TrGauge, full HTML-parity layout; Firebase stock notes (stock_comments collection); Insider & Key Levels side-by-side; Ask Copilot button removed from sd-actions |
| options | screens/options.tsx | Intelligence | UI complete — options chain table (calls + puts), expiry tab selector (horizontal scroll on mobile), left stock search sidebar; static data |
| insider | screens/insider.tsx | Intelligence | UI complete — tabbed: Insider activity (Form 4 feed) + 13F institutional view |
| themes | screens/themes.tsx | My Money | UI complete — 8 curated sector themes; StockPanelLayout (read-only StockRow list, no delete, 3-col grid); ChartCard + StockScreenEmbed below |
| portfolio | screens/portfolio.tsx | My Money | UI complete — StockPanelLayout (340px StockListCard + ChartCard + StockScreenEmbed); holdings add/remove/sell; AI drivers/laggards/leaders; imports from stock-panel.tsx |
| watchlist | screens/watchlist.tsx | My Money | UI complete — StockPanelLayout (340px StockListCard + ChartCard + StockScreenEmbed); delete confirmation modal; `localStorage("iq-watchlist")` persists list; imports from stock-panel.tsx |
| commentary | screens/commentary.tsx | Context | UI complete — Live/Premarket/AH/My names/Macro tabs; ticker search bar (SEARCH_SYMS autocomplete); `NewsDrawer` slides in with `buildNewsHistory()` categorized items (Catalyst/Technical/Sector/Analyst/Earnings/Calendar/Coverage/Product/Guidance); Quick news lookup card at bottom of col-8 (context-aware: "Tracked names" on My names tab); General perspective card has flex:1 |
| recap | screens/recap.tsx | Context | UI complete — `RcpIndexCards` (9-index pulse grid using `data.pulse` + `Spark` sparklines); `NewsBriefing` newspaper two-page spread (NEWS_DAILY / NEWS_WEEKLY arrays, `stockifyText()` inline ticker parsing); social share buttons (X/LinkedIn/WhatsApp/Facebook/Telegram via `window.open()`); `ScheduleShare` form (frequency/time/email — demo state); EOD/Weekly tabs; AI recap hero, sector heatmap, earnings movers, market internals |
| macro | screens/macro.tsx | Context | UI complete — MacroEvent interface; 3-week calendar (CAL_LAST/THIS/NEXT); 8-column table |
| settings | screens/settings.tsx | — | Settings + dark mode wired to Firestore |
| manage-plan | screens/manage-plan.tsx | — | UI scaffold |

Cmd+K Command Bar

-   Global `Cmd+K` (or `Ctrl+K`) opens the palette overlay in `IQShell`. Searches menu items and tickers by label/slug. Keyboard navigation (↑↓ arrows, Enter, Escape). Navigates via Next.js `router.push()`. Phase 2: fuzzy ticker search via API.

4\. Security Architecture

  ------------------- ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Concern**         **Implementation**
  Authentication      Firebase Authentication with email/password + Google OAuth. Firebase ID tokens (1 hr TTL) verified server-side via Firebase Admin SDK; refresh tokens managed automatically by Firebase client SDK
  Authorization       Row-level access: all portfolio, watchlist, and alert queries are scoped to authenticated user\_id. Subscription tier gating enforced at API middleware layer
  API Keys (vendor)   All external API keys stored in AWS Secrets Manager, injected as env vars at ECS task startup. Never in code or client
  Data in transit     TLS 1.3 enforced everywhere. HSTS headers on frontend. WebSocket connections use WSS
  Data at rest        Firestore data encrypted at rest by default (Google-managed keys). S3 server-side encryption. Redis AUTH token required
  Rate limiting       Per-tier rate limits enforced at ALB + API middleware. DDoS protection via AWS Shield Standard
  Input validation    Zod schema validation on all API request bodies. Firestore security rules enforce collection-level access; no raw query injection vectors. Content Security Policy headers
  ------------------- ---------------------------------------------------------------------------------------------------------------------------------------------------------------

5\. Performance & Scalability Targets

  ---------------------------- ---------------------------- ---------------------------------------------------
  **Metric**                   **Target**                   **Strategy**
  API response time (p95)      \< 200ms                     Redis cache, Firestore document reads, CDN for static data
  WebSocket feed latency       \< 1 second                  Redis pub/sub, async fan-out, keep-alive pings
  Page LCP (desktop)           \< 2 seconds                 Code splitting, lazy loading, Vercel Edge CDN
  AI summary generation        \< 5 minutes post-earnings   BullMQ priority queue, pre-staged prompts
  Concurrent WebSocket users   10,000+                      Horizontal ECS scaling, Redis fan-out
  Alert delivery               \< 60 seconds                BullMQ high-priority queue, SendGrid dedicated IP
  Uptime SLA                   99.9%                        Firestore 99.999% SLA (Google-managed), ECS across 2 AZs, ALB health checks
  ---------------------------- ---------------------------- ---------------------------------------------------

6\. Infrastructure

**Current (Frontend MVP)**

-   **Firebase Hosting**: serves the Next.js static export (`out/` directory). Project ID: `fin-app26`. Deployed via `firebase deploy --only hosting`. Clean URLs enabled; all routes rewrite to `index.html` for SPA navigation.

-   **Firebase Authentication**: email/password + Google OAuth. Firebase ID tokens issued client-side; `FirebaseListener` monitors `onAuthStateChanged` and syncs to Redux store. **iOS Safari fix** (`app/firebase.ts`): `firebaseAuth` is now initialised via `initializeAuth` (not `getAuth`) with `persistence: [indexedDBLocalPersistence, browserLocalPersistence]` and `popupRedirectResolver: browserPopupRedirectResolver`, wrapped in a try/catch fallback to `getAuth` for hot-reload re-initialisation safety. All Google sign-in handlers (LoginForm, SignupForm, landing page) use popup-first with redirect fallback: `signInWithPopup` → on `auth/popup-blocked` → `signInWithRedirect`. `LoginForm` and `SignupForm` both call `getRedirectResult(firebaseAuth)` in a `useEffect` on mount to pick up pending redirect credentials. Fixes iOS Safari ITP which blocks cross-origin cookies used by the `firebaseapp.com` redirect domain.

-   **Landing page fixes** (`app/landing.css`, `app/page.tsx`): `.lp-root.mq-root` background is now `transparent` (was `#000`), unblocking the WebGL wave canvas rendered behind the root element. `ScaledScreen` now uses a `ResizeObserver` to compute `scale = containerWidth / 1200` dynamically instead of the previous hardcoded constant, fixing glance-modal card previews at any container width.

-   **Cloud Firestore**: primary data store. Collections live: `users/{uid}` (profile), `settings/{uid}` (user preferences including dark mode), `stock_comments` (user chart notes — saved from Stock Detail page right-click context menu; schema: `{uid, sym, name, comment, createdAt: Timestamp}`). Security rules enforced via `firestore.rules` (deployed via `firebase deploy --only firestore:rules`). Firebase project: `fin-app26`.

**Planned (Backend / Phase 2 — not yet deployed)**

*All backend workloads planned for AWS us-east-1.*

-   VPC with public subnets (ALB, NAT Gateway) and private subnets (ECS tasks, Redis)

-   ECS Cluster: api-service (2--10 tasks), websocket-service (2--8 tasks), ingestion workers (per-worker task definitions), ai-workers (1--4 tasks)

-   ElastiCache Redis: cache.r6g.large, cluster mode disabled (single shard), Multi-AZ with auto-failover

-   ClickHouse: self-managed on EC2 (r6i.2xlarge), single node MVP, cluster in Phase 2

-   S3: market-platform-prod bucket, versioning enabled, lifecycle policy to Glacier after 90 days

-   CloudFront: CDN for S3 audio files and static asset acceleration

-   Route 53: DNS with health checks; automatic failover
