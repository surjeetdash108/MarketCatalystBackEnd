
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

**MarketCatalyst — Market Intelligence Terminal**


> ## ⏱ State sync — 2026-07-24 (current deployed reality)
>
> _This block reflects what is actually built, deployed, and running as of
> 2026-07-24. Where anything below predates it, this block is authoritative._
>
> **This doc, specifically:** This tracker's §6 topology and §6.1 interaction paths already reflect the split; the new `/live/collections` cache is the latest addition.
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
>
> **Amended 2026-07-22:** "no REST API exposed to the frontend" is no longer
> strictly true. The backend now serves real read APIs — `GET /plans`,
> `GET /users/:uid/entitlements`, `GET /admin/users|subscriptions|revenue`
> (`src/plans/`), `GET /live/market-status`, `GET /live/snapshot` — but the
> browser **cannot reach any of them in production**: `NEXT_PUBLIC_BACKEND_URL`
> is unset, so `http://localhost:4100` is baked into the static bundle and
> blocked as mixed content. Everything the app renders today therefore still
> arrives via the Firestore client SDK. See §7 Known Gaps.
>
> **Amended 2026-07-23 — the two 2026-07-22 gaps are now CLOSED, and the runtime
> topology changed.** (1) The backend was split into **two Cloud Run services
> from one image** via an `APP_ROLE` env var: a **private `worker`**
> (`market-catalyst-backend`, `--no-allow-unauthenticated`) that mounts every
> admin/sync module, and a **public `live`** (`market-catalyst-live`,
> `--allow-unauthenticated`) that mounts **only** `LiveModule` + `/health` — so
> the browser can reach `/live/*` without exposing `/sync`·`/purge`·`/admin`
> (they 404 on the public service, verified). `NEXT_PUBLIC_BACKEND_URL` now
> points at the `live` service, baked in at build. (2) **22 Cloud Scheduler jobs
> are ENABLED and firing**, POSTing the worker's `/sync/{job}/run` with an OIDC
> token (`scheduler-invoker` SA). So the app now interacts with the backend over
> HTTP in two live ways — **SSE** (ticker tape) and **cached JSON polling**
> (delayed prices, market status) — on top of the Firestore client SDK path. See
> the new **§6.1 Runtime interaction paths** for the full enumeration and the
> companion architecture diagram. The Firestore-direct path remains the source
> for all *domain* data; the `/live/*` HTTP path adds only the moving-price
> surfaces (tape, watchlist/portfolio/search/stock quotes, market-status pill).

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

*Actual implementation (2026-07-22): 25 in-process `@Cron` jobs in
`backend/src/sync/*.job.ts`, not ECS workers. Added since this table was
written:*

  ------------------------- ----------------------------- ------------------------- ------------------------------------------------------------------
  **Job**                   **Source**                    **Cron (ET)**             **Writes To**
  intraday-bars             Polygon aggs (5m / 30m)       `25 16 * * 1-5`           `intraday_bars/{ticker}_{5min|30min}` — ONE doc per ticker+resolution holding an ARRAY of bars
  corporate-actions         Polygon dividends + splits    `40 6 * * *`              `dividend_history/{ticker}` (full payment history, annual + TTM totals, derived yield, 5y CAGR, increase streak), `splits/{ticker}`
  ------------------------- ----------------------------- ------------------------- ------------------------------------------------------------------

*Changed jobs:* `stock-history` backfills **5 years** (was 300 days), clamped to
the Polygon plan's rolling 5-year edge, with an `earliestSyncedFrom` watermark
so history fills BACKWARDS as well as forwards (`lastSyncedThrough` only ever
advances, so raising the constant alone did nothing); `technical-indicators`
adds `rsi14Series`, SMA/EMA ladders (10/20/30/50/100/200), `vwap`,
`high52`/`low52`, `avgVolume20/50`; `financials` now persists balance sheet,
cash flow, margins and current ratio (previously fetched and discarded);
`options-chains` adds per-contract OHLC/VWAP/trade count; `market-indices`
now sources **US10Y from the real Treasury-yield endpoint** (`/fed/v1/treasury-yields`)
— it was previously the TLT ETF, which moves *inversely* to the yield it was
labelled as. `src/live/snapshot-cache.service.ts` moved to the **v3 universal
snapshot** (adds early/late/regular trading change percentages and
`marketStatus`); `src/live/market-status.service.ts` (new) fetches
`/v1/marketstatus/*` with a 60s cache and serves `GET /live/market-status`,
replacing the browser's hand-maintained holiday table.

*Polygon plan limits (probed live, Stocks Starter):* exactly **900 s (15 min)
delay** and exactly **5-year rolling history**. Authorized: daily + intraday
aggs, grouped daily, v2/v3 snapshots, reference tickers/dividends/splits/IPOs/news,
`/v1/related-companies`, `/v1/indicators/*`, `/v1/marketstatus/*`,
`/vX/reference/financials`, option **contract** aggs, `/fed/v1/*`. Not authorized
(403): options snapshot (greeks/IV/OI/bid-ask), index values (I:SPX, I:VIX),
trades/quotes/last-trade, `/benzinga/v1/*`, `/v1/summaries`. 404: short interest,
futures.

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

Live-data hooks (`app/iq/hooks/`, added 2026-07-22)

-   **`useChartBars(sym, tf)`** — supersedes the daily-only `useOhlcvBars`. All 7 timeframes now read real bars: 1D/1W from `intraday_bars/{ticker}_5min` (sliced to the last N sessions), 1M from `_30min`, 3M–5Y from `ohlcv_bars`. Previously 1D/1W/1M/5Y fell through to `genOHLC`, a seeded random walk.
-   **`useCompany(sym)`** — a single `companies/{ticker}` document read, deliberately not `useCollection("companies")` (which subscribes to the whole collection and filters in the browser). Carries the new Polygon-sourced `peers`, `dividendYield`, `dividendPerShare`.
-   **`useDividendHistory(sym)`** / **`useSplits(sym)`** — read `dividend_history/{ticker}` and `splits/{ticker}`. These replace client-side extrapolation that derived quarterly amounts as `annual / 4` decayed 6.5%/yr and reported a literal constant "+6.5% 5-yr dividend growth" for every company. Splits are surfaced (not just stored) because `stock-history` refetches with `adjusted=true`, so a split silently rewrites price history.
-   **`useExtendedHours(tickers, session)`** — pre-market / after-hours moves from the v3 snapshot's `early_trading_change_percent` / `late_trading_change_percent`, replacing a hardcoded `PREMARKET`/`AFTERHOURS` array. **Calls the backend over HTTP, so it is dead in production** (see §7).

3.6 Subscriptions, Entitlements & Admin Analytics (Current Implementation, 2026-07-22)

Backend — `src/plans/` (`PlansModule`)


> **Seeding prunes, and must.** `seed()` merges, and a merge can only ever ADD a
> key — so an entitlement removed or renamed in the registry survives in
> Firestore indefinitely, granting access that no longer maps to anything.
> Observed live: splitting `advancedCharts` into finer keys left it behind on all
> three plans, and an older Cloud Run revision booting mid-deploy merged it
> straight back in. `seed()` now deletes keys absent from the registry using
> `FieldValue.delete()` on dotted paths — a merged map write cannot express
> removal. Any future rename depends on this.

-   **`plans.registry.ts`** — 30 entitlement keys, 3 plan definitions, `formatAmount()`. This is the **seed**, not the runtime source of truth: plans live in the `plans` Firestore collection so pricing and packaging can change without a redeploy. Seeding is merge-based, so operator edits survive a re-seed.
-   **`plans.service.ts`** (seed/read `plans`), **`subscriptions.service.ts`** (effective subscription per user), **`admin-analytics.service.ts`** (read-models), plus **`plans.controller.ts`** and **`admin-analytics.controller.ts`**.
-   **Registered in `app.module.ts`** alongside `FeatureFlagsModule`, from which it is deliberately kept separate — see the two-layer model below.

  ---------------------------------------- ------------ ----------------------------------------------------------------------
  **Endpoint**                             **Guard**    **Returns**
  `GET /plans`                             public       Pricing table. Amounts are MINOR units.
  `POST /plans/seed`                       AdminGuard   Merge-seeds the 3 plan documents.
  `GET /users/:uid/entitlements`           AdminGuard   Effective subscription + per-key `{released, entitled, enabled, reason}`.
  `GET /admin/users`                       AdminGuard   User rows (limit 1–2000, default 500).
  `GET /admin/subscriptions`               AdminGuard   Subscription rows (limit 1–5000, default 1000).
  `GET /admin/revenue`                     AdminGuard   Revenue roll-up by plan and by month.
  ---------------------------------------- ------------ ----------------------------------------------------------------------

`/users/:uid/entitlements` is AdminGuard-only today rather than self-service,
because unauthenticated per-user reads would leak another user's subscription;
per-user access arrives once the Hosting rewrite lands and requests carry a
Firebase ID token.

Admin read-models aggregate **server-side**, not in the browser: revenue must
not depend on a client correctly summing minor units, and `users` is
owner-scoped in Firestore rules. **Staff accounts are excluded from every
metric** — the admin is not a customer, and at this user count one staff row
moves Total Users, plan mix, ARPU and the churn denominator by 20%+.
`excludedStaff` is returned so the exclusion is auditable.

The plan ladder (live in Firestore, cumulative by construction)

  --------- ---------- ---------------- ------------ ------------ -----------------------------------------------------------
  **id**    **name**   **amount**       **cycle**    **grants**   **Adds over the tier below**
  free      Free       0 USD            none         8 / 30       marketCatalyst, news, scanner, heatmap, macro, ipos, chartsDaily, watchlist
  plus      Plus       2999 USD         monthly      20 / 30       chartsIntraday, chartsHistory, chartIndicators, chartNotes, technicalRatings, dividendHistory, peers, earningsDetail, portfolio, screener, themes, alerts
  pro       Pro        4999 USD         monthly      28 / 30      fundamentalRatings, ownership, optionsChain, exportData, apiAccess, aiAssistant, backtesting, paperTrading
  --------- ---------- ---------------- ------------ ------------ -----------------------------------------------------------

-   **Amounts are MINOR units (cents), matching Stripe** — 4999 is $49.99. Storing major units would bill 100× wrong on the first real charge, so nothing may bypass `formatAmount()` for display.
-   The tiers are **composed**, not written out three times, so an upgrade can never drop a feature the customer was already using.
-   `adminDashboard` and `userManagement` are forced **false on every plan**. They are staff capabilities; selling them would be privilege escalation, not an upsell. That is why Pro is 28/30 and not 30/30.
-   **Expiry is computed, not trusted.** Nothing rewrites a user document at the moment a subscription lapses, so a stored `ACTIVE` would grant paid access forever. The stored status is treated as *intent*; the date is treated as *truth*. Both `SubscriptionsService.resolve()` and the client mirror this. A lapsed subscription falls back to **FREE, never to no-access**.

The two-layer gating model — do not merge these

Two independent questions are answered by two independent registries, and a
feature is usable only when **both** say yes:

```
FF_* release flag              plan entitlement
"is it built and shipped?"     "may this tier use it?"
feature-flags.registry.ts      plans.registry.ts
(25 FF_* keys)                 (30 entitlement keys)
        │                              │
        └──────────── AND ─────────────┘
                      ▼
        released && entitled → render
        !released            → "Coming soon"
        released && !entitled→ "Upgrade to unlock"
```

They are joined only at the controller edge (`RELEASE_FLAG_FOR` in
`plans.controller.ts`, mirrored in `app/iq/entitlements.tsx`), never in storage.
Collapsing them into one boolean would make an **unbuilt** feature
indistinguishable from a **paywalled** one — the app would advertise an upgrade
for something it cannot deliver. `backtesting` and `paperTrading` are the live
proof: both are granted on Pro but neither is implemented, so they are listed in
`UNBUILT` and reported `released: false` regardless of plan, and the UI says
"coming soon". An entitlement with no mapped release flag (e.g. `apiAccess`) is
treated as always released and gated on the plan alone.

Frontend gating

-   **`app/iq/entitlements.tsx`** — `EntitlementProvider` (one `onSnapshot` on `plans`, one on `users/{uid}`, so a pricing or packaging change reaches users with no redeploy and no reload), `useSubscription`, `useEntitlement` (the AND), `EntitlementGate`, `formatAmount`. Per-user `featureFlags` on the user document override the plan map, for comps and support grants.
-   **`app/iq/entitlement-gate.tsx`** — `SLUG_ENTITLEMENT` (screen slug → entitlement key), `PlanGate` (renders the upgrade panel, never a "coming soon" one), `useSlugEntitled` (hides nav entries). Separate from `SLUG_FLAG` in `feature-flags.tsx`, which maps a slug to its *release* flag. While either layer is still resolving, `reason: "loading"` suppresses the paywall and keeps nav items visible, so the UI never flashes a lock at a paying user.
-   **`app/iq/feature-adoption.ts` + `track-feature.tsx`** — 48 tracked surfaces: screens derived from `menuItems` (so nav and catalog cannot drift) plus in-app *actions* (8 Stock Detail drawers, chart timeframe/indicator/expand, watchlist add/remove, search, screener, news). Action rows are what answer "is this feature earning its keep" — screen-level counts alone hide a drawer nobody ever opens. One document per (feature, user) at `feature_adoption/{feature}__{uid}`, 30-second dedupe (React strict mode double-invokes effects), failures swallowed so analytics never breaks the screen it measures. `TrackFeature` is mounted *inside* `ScreenGate`, so a flag-blocked screen is not counted as opened.

Admin console architecture (`/admin`)

The console is the original standalone static page, `public/admin/console.html`,
embedded verbatim in an **iframe** by `app/admin/page.tsx`. Three consequences
follow from that choice, and each is load-bearing:

1.  **The React parent owns the session.** It awaits `firebaseAuth.authStateReady()` before judging the user (`onAuthStateChanged` fires an initial `null` while Firebase restores from IndexedDB, which bounced the admin straight back out), admits only `ADMIN_EMAIL`, and redirects everyone else.
2.  **Data is staged in `sessionStorage` BEFORE the iframe mounts.** `app/admin/admin-data.ts` (`buildAdminDataset()`) reads Firestore *as the signed-in admin*, so `isAdmin()` in the rules is what permits the cross-user `users` read, and writes the result to `admin:data`. The console renders once at module scope, so anything delivered after its load would be ignored — `postMessage` is too late by construction. Same origin, so `sessionStorage` is shared. On failure the key is *removed*, so the console falls back to its own demo data and sample-data banner rather than rendering an empty console that looks like a real business with no customers.
3.  **Writes are delegated to the parent over `postMessage`.** The iframe has no Firebase SDK. Toggling a per-plan entitlement posts `admin:setPlanFlag`; the parent performs `updateDoc(plans/{id}, { "featureFlags.<key>": value, updatedAt })` — a **dotted path**, so a concurrent edit to a different flag is not clobbered — and posts back `admin:setPlanFlagResult`. `admin:logout` and `admin:changePassword` use the same bridge.

The console additionally gained a **Monitor** nav item that lazily embeds the
backend ops UI on first visit (probed before embedding, since an iframe to an
unreachable or 403 origin renders a browser error page), and its fabricated
trend deltas and fake MRR history chart are suppressed whenever real data is
present — invented figures against real users would look authoritative.

New Firestore collections

`intraday_bars`, `dividend_history`, `splits`, `plans`, `payments`,
`subscriptions`, `feature_adoption`, `api_usage`, `audit_logs`,
`revenue_summary`, `system_metrics`. Currently populated: `intraday_bars` (474),
`dividend_history` (241), `splits` (241), `plans` (3), `feature_adoption` (~12
seeded). Empty: `payments`, `subscriptions`, `api_usage`, `audit_logs`,
`revenue_summary`, `system_metrics`.

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
  Admin identity      `isAdmin()` = `token.admin == true` **OR** `token.email == ADMIN_EMAIL`. Same account admitted by the backend `AdminGuard` and by the Firestore ruleset, so the two cannot disagree
  Plan enforcement    Two layers ANDed (§3.6): FF\_\* release flags + plan entitlements. Client gating is UX; the authoritative resolution is `SubscriptionsService` behind `AdminGuard`. Amounts are server-only in the ruleset
  ------------------- ---------------------------------------------------------------------------------------------------------------------------------------------------------------

Firestore ruleset (live, 2026-07-22)

The deployed ruleset is **`MarketCatalystUI/firestore.rules`**. ⚠ Both repos ship
a `firestore.rules`; they have **drifted**, and the backend copy is stale and now
carries a DO-NOT-DEPLOY header.

-   `isAdmin()` deliberately does **not** require `email_verified`. The admin is a password account with `emailVerified=false`; requiring it locked the admin out of Firestore while the backend guard still admitted the same account — a split-brain worse than the check was worth.
-   `plans`: an admin may update **`featureFlags` + `updatedAt` only**. Price, currency and billing cycle stay server-only — a client that could rewrite `amount` could set a plan to $0. Create and delete are denied.
-   `payments` / `subscriptions`: admin reads all; a user reads only their own.
-   `api_usage` / `feature_adoption` / `audit_logs` / `revenue_summary` / `system_metrics`: admin read only.
-   `feature_adoption` is the **only client-writable analytics collection**, because the browser cannot reach the backend (§7). It is tightly constrained: the row must belong to the caller, `openCount` may only increase, ownership cannot change, delete denied.
-   `users`: owner **or** admin read.
-   **Two pre-existing bugs fixed**: `market_sentiment` and `stock_comments` had no rule at all, so default-deny silently blocked the Dashboard Fear & Greed gauge (which fell back to a hardcoded 62 / "Greed") and the chart-notes feature.

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

**Deployment topology (actual, 2026-07-23)**

```
                         Firebase Auth ◄──► Browser (SPA)
                                              │  Next.js static export
                Firebase Hosting ────────────┤  served from Firebase Hosting
                (marketcatalyst.web.app)      │  project fin-app26 / market-catalyst-502415
                                              │
      ┌───────────────────────────────────────┼───────────────────────────────────┐
      │ Cloud Firestore (client SDK)           │ Cloud Run: market-catalyst-live    │
      │  • onSnapshot reads  ◄── all domain    │  (PUBLIC, --allow-unauthenticated) │
      │    data the app renders                │  APP_ROLE=live · LiveModule only   │
      │  • owner-scoped writes ──► watchlists, │  • GET  /live/snapshot  (poll+ETag)│
      │    holdings, settings, comments,       │  • SSE  /live/tape/stream (tape)   │
      │    feature_adoption                    │  • GET  /live/market-status        │
      └────────────────────────────────────────┴──────────────┬────────────────────┘
                    ▲ Admin SDK writes                          │ on-demand vendor calls
                    │                                           ▼
   Cloud Run: market-catalyst-backend (PRIVATE)          Polygon / Massive (delayed)
     --no-allow-unauthenticated · APP_ROLE=worker
     mounts SyncModule/Purge/Plans/Admin/Live            External vendors (worker only):
       ▲ POST /sync/{job}/run (OIDC)                     Polygon, FMP, Finnhub, SEC EDGAR, FRED
       │                                                 (FMP/Finnhub = NOT redistributable,
   Cloud Scheduler (22 jobs, ENABLED)                     never served to the browser)
     scheduler-invoker SA · cron ET                      Secret Manager ──► both services (keys)
```

-   **Two Cloud Run services, one image, region `us-central1`**, split by `APP_ROLE`:
    -   **`market-catalyst-backend`** (worker, PRIVATE, `--no-allow-unauthenticated`, `min=0 max=3`, 512Mi/900s) — every admin/sync/purge/plans module. Reached only by Cloud Scheduler (OIDC) and operators.
    -   **`market-catalyst-live`** (PUBLIC, `--allow-unauthenticated`, `min=0 max=5`, `concurrency=200`, 1Gi/3600s) — `LiveModule` + `/health` only; `/sync`·`/purge`·`/admin` are **not routed** here (404, verified). `CORS_ORIGINS=https://marketcatalyst.web.app`.
-   **Cloud Scheduler**: 22 jobs ENABLED, each POSTs the worker's `/sync/{job}/run` on its cron (ET) with an OIDC token minted for the `scheduler-invoker` service account. Data now refreshes automatically; no more manual runs.
-   **Frontend**: `https://marketcatalyst.web.app` — Firebase Hosting, static export. `NEXT_PUBLIC_BACKEND_URL` = the `live` service URL, inlined at build.
-   **Secret Manager**: vendor keys injected into both services at startup, never in env files or code.
-   **Rules**: released from `MarketCatalystUI/firestore.rules`.
-   No AWS, ECS, ALB, ElastiCache, ClickHouse, S3, CloudFront or Route 53 exists. The Phase-2 block below remains *proposed*, not running.

**6.1 Runtime interaction paths (2026-07-23)**

The distinct ways the systems talk to each other at runtime — the basis for the
companion architecture diagram. "Client" = the browser SPA.

| # | From → To | Transport | Carries |
|---|---|---|---|
| 1 | Browser ⇄ **Firebase Hosting** | HTTPS (static) | The Next.js `out/` bundle + assets |
| 2 | Browser ⇄ **Firebase Auth** | Firebase SDK | Sign-in/up, `onAuthStateChanged`, 1h ID tokens → Redux via `FirebaseListener` |
| 3 | Browser ⇄ **Firestore** (read) | Client SDK `onSnapshot` | **All domain data** — companies, market_indices, movers, sectors, breadth, earnings_events, news, financials, dividends, splits, ipos, recaps, market_sentiment(_history), plans, entitlements |
| 4 | Browser → **Firestore** (write) | Client SDK, owner-scoped | User-owned data — watchlists, portfolio holdings, settings, stock_comments, feature_adoption (the only client-writable analytics) |
| 5 | Browser → **Cloud Run `live`** | HTTPS `GET /live/snapshot` (poll 15s, `cache:no-store` + `If-None-Match`) | Delayed batched quotes for the shared live-price subscription (watchlist, portfolio, search, stock detail) |
| 6 | Browser ⇄ **Cloud Run `live`** | **SSE** `GET /live/tape/stream` (EventSource) | The header ticker tape — one `ReplaySubject` broadcast; one vendor call/min for **all** users |
| 7 | Browser → **Cloud Run `live`** | HTTPS `GET /live/market-status` | Session pill (pre/open/after/closed) + extended-hours |
| 8 | **Cloud Run `live`** → **Polygon/Massive** | HTTPS (on demand, ref-counted) | `/v3/snapshot` (20 tape syms + snapshot tickers) + `/fed/v1/treasury-yields`; delayed ~15m |
| 9 | **Cloud Scheduler** → **Cloud Run `worker`** | HTTPS `POST /sync/{job}/run` + OIDC | 22 cron jobs firing the ingestion pipeline |
| 10 | **Cloud Run `worker`** → **Vendors** | HTTPS, adapter layer w/ fallback | Polygon (redistributable) + FMP/Finnhub/EDGAR/FRED (worker-only) |
| 11 | **Cloud Run `worker`** → **Firestore** | Firebase **Admin SDK** (write) | Every synced domain collection + `sync_meta`; `recaps` composes existing collections |
| 12 | **Secret Manager** → both Cloud Run services | env injection at startup | Vendor API keys |
| 13 | Admin iframe ⇄ React parent | `postMessage` + `sessionStorage` | Admin dataset staged pre-mount; plan-flag writes delegated to the parent's client SDK |
| 14 | Browser + worker → **Sentry** | HTTPS (DSN-gated no-op until set) | Error/exception capture |

**The load-bearing rule:** domain data flows **Browser ⇄ Firestore** (paths 3–4);
the backend HTTP paths (5–8) add *only* moving prices and market status; the
worker never serves the browser and non-redistributable vendor data (FMP/Finnhub)
never leaves the worker.

7\. Known Gaps (2026-07-22)

Stated plainly because each one changes what the deployed system can actually do:

1.  ✅ **RESOLVED 2026-07-23 — the browser now reaches the backend, safely.** Instead of the risky Hosting→Cloud Run rewrite (which would have needed `ADMIN_GUARD_TRUST_IAM=false` to avoid exposing `/sync`·`/purge`·`/retention`), the backend was split into two Cloud Run services from one image (`APP_ROLE`): a public **`live`** service mounting *only* `LiveModule` + `/health`, and the existing private **`worker`**. `NEXT_PUBLIC_BACKEND_URL` points at `live`, so the tape, delayed prices, extended-hours and market-status pill are live for real users, while `/sync`·`/purge`·`/admin` return 404 on the public service (verified) — no admin surface was exposed. Stripe checkout/webhook (gap 4) is now unblocked on the infra side.
2.  ✅ **RESOLVED 2026-07-23 — Cloud Scheduler is live.** 22 jobs are ENABLED and firing on their crons, the `scheduler-invoker` service account exists, and each job POSTs the worker's `/sync/{job}/run` with an OIDC token. Data now refreshes automatically; the "every row came from a manual run" caveat no longer holds.
3.  **`POLYGON_API_KEY` is un-rotated** (it was exposed in chat). Secret Manager version 4 is enabled. `deploy/rotate-polygon-key.sh` automates the whole rotation except generating the replacement key.
4.  **Stripe is not implemented.** No Stripe code exists in either repo; `stripePriceId` is `null` on every plan, which keeps them non-purchasable. `payments` and `subscriptions` are empty collections. Checkout and webhooks are blocked on gap 1.
5.  **`api_usage` is specified but not implemented** — no middleware records API calls, so the admin console's "Usage & API" KPIs read 0.
6.  **Engagement columns are 0** in the admin console (watchlists / holdings / apiCalls / alerts per user): there is no collection behind them yet. Reported as 0 rather than estimated — the console's own PRNG-generated demo figures were deliberately suppressed against real users.

8\. Planned (Backend / Phase 2 — not deployed, not started)

*All backend workloads planned for AWS us-east-1.*

-   VPC with public subnets (ALB, NAT Gateway) and private subnets (ECS tasks, Redis)

-   ECS Cluster: api-service (2--10 tasks), websocket-service (2--8 tasks), ingestion workers (per-worker task definitions), ai-workers (1--4 tasks)

-   ElastiCache Redis: cache.r6g.large, cluster mode disabled (single shard), Multi-AZ with auto-failover

-   ClickHouse: self-managed on EC2 (r6i.2xlarge), single node MVP, cluster in Phase 2

-   S3: market-platform-prod bucket, versioning enabled, lifecycle policy to Glacier after 90 days

-   CloudFront: CDN for S3 audio files and static asset acceleration

-   Route 53: DNS with health checks; automatic failover
