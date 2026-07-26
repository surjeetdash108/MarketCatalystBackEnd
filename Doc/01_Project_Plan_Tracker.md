
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
> high-frequency set (tape universe + every user's watchlist/portfolio +
> `ticker_usage` top-100) through the on-demand cache; ② market-wide jobs
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
> **This doc, specifically:** For this plan: the W1–W5 data/UI milestones are delivered; only the AI narrative layer (Anthropic/OpenRouter) and Benzinga-gated estimates remain.
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


Project Plan \| v1.2 \| July 2026

> **⚠ Implementation status (updated 2026-07-22):**
> A new workstream has since landed that this plan did not anticipate as a
> separate epic — **Subscriptions, Entitlements & Admin Analytics** (see §2.4).
> It delivered the *entitlement* half of "Subscription & Billing" without the
> *payment* half: a `plans` registry with 30 entitlement keys, three plans live
> in Firestore (`free` / `plus` / `pro` — **not** the Free/Pro/Premium naming in
> §7), an admin-guarded analytics API, a real-data admin console with a per-plan
> feature editor, and 48-feature adoption tracking. **Stripe remains entirely
> unimplemented — there is no Stripe code in either repo**, and the `payments`
> and `subscriptions` collections are empty. In parallel, the Polygon data
> wiring was substantially completed (5-year history backfill, intraday bars,
> dividends/splits, balance sheet + cash flow, real RSI/MA/EMA/VWAP/52-week,
> real US10Y Treasury yield replacing a TLT-ETF proxy that moved *inversely* to
> the yield it was labelled as).
>
> **Two deployment facts materially qualify every "done" claim below.**
> (1) `NEXT_PUBLIC_BACKEND_URL` is unset, so `http://localhost:4100` is baked
> into the production bundle and blocked as mixed content — **the browser cannot
> reach the backend at all** in production. (2) **No Cloud Scheduler jobs exist
> in any region** and there is no `scheduler-invoker` service account
> (`create-scheduler-jobs.sh` was never run); with `min-instances=0` the
> in-process `@Cron` decorators never fire, so **no sync job has ever run
> automatically in production** — all Firestore data came from manual runs.
> Everything Firestore-backed is genuinely live; everything backend-backed is
> built but unreachable. See §9 for the full gap list.
>
> **⚠ Implementation status (updated 2026-07-09, first noted 2026-07-05):**
> This plan describes the original proposed stack — AWS ECS, Redis,
> ClickHouse, BullMQ, Fastify, Stripe billing. What was actually built is
> simpler: a single NestJS backend (`backend/`) syncing
> Polygon/FMP/Finnhub/FRED/SEC EDGAR directly into Firestore via 17 cron
> jobs, with no Redis/ClickHouse/BullMQ/Stripe/Fastify/ECS anywhere in the
> stack. No subscription billing exists yet; Firestore's tier-gating rules
> are relaxed to "any authenticated user" pending that decision. Since this
> note was first added, further build-out has continued in the same
> direction (not a stack change): full US ticker-universe price coverage,
> an IBD-style RS Rating computed from real OHLCV history, a Polygon-primary
> news adapter with automatic Finnhub fallback, materialized portfolio
> totals written back to Firestore, and backend ops tooling (per-job
> Firestore-collection/cron-schedule/next-run tracking, a manual
> "run all jobs" trigger) — the last of these is purely an internal ops
> dashboard, not a MarketCatalyst feature. For what's actually implemented, see
> `Doc/openapi.yaml` (the real API contract, with per-endpoint
> `x-status: live|planned`), `Doc/schema.sql` (relational schema if
> migrating off Firestore), `Doc/screen-data-sources.md` (per-screen live/
> static breakdown, most current), and `backend/src/sync/` (the real jobs).
> The phases/timelines below are kept for historical/roadmap context, not
> as a description of current reality.

1\. Executive Summary

This document is the master project plan for building a subscription-based active investor intelligence platform that consolidates Briefing.com, Earnings Hub, and MarketSurge into a single product with AI-powered insights. The platform targets active retail investors, swing traders, and portfolio investors who need live market intelligence, earnings research, analyst actions, 13F tracking, and peer/group context in one workflow.

The project (branded **MarketCatalyst**) is structured in two phases: MVP (18 weeks) delivering core market data, earnings workspace, and portfolio features; and Phase 2 (additional 20 weeks) adding institutional intelligence, AI Copilot, and mobile. The full UI shell, design system, auth pages, and marketing landing page are complete as of June 2026.

2\. Project Phases

2.1 Phase Overview

  ----------------------- ------------------------------------------------------- -------------- -------------- --------------------------------
  **Phase**               **Theme**                                               **Duration**   **Timeline**   **Success Metric**
  Phase 1 --- MVP         Core platform, live data, earnings, portfolio           18 weeks       Weeks 1--18    50 beta users, \<2s page loads
  Phase 2 --- Expansion   13F, Options, AI Copilot, Mobile, Story Stocks, Cmd+K   20 weeks       Weeks 19--38   500 paying subscribers
  Phase 3 --- Growth      Social, broker import, rotation alerts                  Ongoing        Weeks 39+      Churn \< 5% monthly
  ----------------------- ------------------------------------------------------- -------------- -------------- --------------------------------

2.2 Phase 1 --- MVP Epics (Weeks 1--18)

  ------------------------ ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- -------------- -------------- --------------
  **Epic / Area**          **Key Deliverables**                                                                                                                                                                                                                                                          **Duration**   **Owner**      **Priority**
  Data Layer               Polygon.io + FMP + Benzinga integrations, WebSocket real-time quotes, news feed ingestion, earnings calendar sync                                                                                                                                                             3 weeks        Backend        P0
  Auth & Infra             Firebase Authentication + Firestore setup, Redis cache, CI/CD pipeline, staging env. **UI complete:** landing page (/), login modal, /auth/login, /auth/signup, /auth/forgot-password. All routes return to / on logo click.                                  2 weeks        Infra          P0
  Home Dashboard           \"What Matters Now\" AI card, Market Pulse strip, session tabs (Today/Premarket/Live/AH/This Week), widget grid scaffold                                                                                                                                                      3 weeks        Full Stack     P0
  Earnings Workspace       Earnings calendar (list + Kanban BMO/AMC views), dense data table, tag pills, drawer panel, EPS/Revenue history chart, AI earnings summary, Earnings Setup Card (pre-announce), Earnings Movers Board, Before the Bell & After the Close briefings                            4 weeks        Full Stack     P0
  Market Movers Board      Gainers/Losers/Volume/Gap/High RVol views, catalyst labeling, filter system (index/sector/cap/float/session), peer reactions, technical context (MA posture), Weekly Movers page                                                                                              2 weeks        Full Stack     P0
  Analyst Actions Board    Real-time upgrades/downgrades/initiations/reiterations table, direction arrows, implied upside/downside, stock reaction since action, AI note per action (meaningfulness), portfolio/watchlist filter                                                                         2 weeks        Full Stack     P1
  Portfolio & Watchlists   Manual portfolio creation, per-holding stats (position size bucket, unusual options flag), Portfolio Pulse card, 12 alert types (earnings, analyst, volume, price, 52-wk breakout, peer move, macro event, block trade, 13F filing, group RS rank), email + in-app delivery   3 weeks        Full Stack     P0
  Stock Detail Page        Interactive price chart (overlaid earnings + analyst actions), key stats, earnings history, institutional ownership (top 10 holders, 13F overlap), options activity flags, block trades, peer view, group view (MarketSurge-style), AI TA section (Phase 2)                   3 weeks        Full Stack     P0
  EOD & Weekly Recap       Automated generation pipeline, article + bullets views, email digest delivery                                                                                                                                                                                                 2 weeks        Backend + FE   P0
  VIX & Macro Calendar     VIX widget, economic calendar table, market regime label, recent macro releases                                                                                                                                                                                               1.5 weeks      Full Stack     P1
  Subscription & Billing   Stripe integration, Free/Pro/Premium tier gates, upgrade flow                                                                                                                                                                                                                 2 weeks        Full Stack     P1
  ------------------------ ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- -------------- -------------- --------------

**Note (2026-07-22):** the *Subscription & Billing* epic above has been split.
Its tier-gating half shipped and is tracked separately in §2.4; its Stripe half
is not started and is blocked on infrastructure (§9, gap 1). The *Data Layer*
epic's \"WebSocket real-time quotes\" was never built and is not planned ---
data reaches the frontend through Firestore sync jobs, at a measured 15-minute
vendor delay.

2.3 Phase 2 --- Expansion Epics (Weeks 19--38)

  -------------------------- ------------------------------------------------------------------------------------------------------------------------------------- -------------- ----------------- --------------
  **Epic / Area**            **Key Deliverables**                                                                                                                  **Duration**   **Owner**         **Priority**
  13F Intelligence           SEC EDGAR ingestion, per-fund page, quarterly digest, AI 13F summaries, cross-fund views                                              4 weeks        Backend + FE      P0
  Options & Block Trades     Unusual Whales API integration, options flow board, block trades board, filters                                                       3 weeks        Backend + FE      P0
  AI Market Copilot          Claude-powered chat panel, portfolio context injection, source citation links                                                         3 weeks        AI + Full Stack   P0
  Audio Recaps               TTS pipeline for EOD/weekly recaps, earnings call audio player (Intrinio)                                                             2 weeks        Backend           P1
  Mobile App                 React Native, bottom tab nav, push notifications, condensed views                                                                     6 weeks        Mobile            P0
  Broker Import              Plaid/SnapTrade OAuth, portfolio sync, position reconciliation                                                                        3 weeks        Backend           P1
  Industry Rotation Alerts   Group rank change detection, push/email notification rules                                                                            1.5 weeks      Backend           P1
  Social Sharing             Recap card image generation, share to Twitter/LinkedIn                                                                                1 week         Full Stack        P2
  **Story Stocks Section**   AI-tagged + manually curated story cards (what/why/catalyst date/peer impact), news cluster density trigger, story feed integration   2 weeks        AI + Full Stack   P1
  -------------------------- ------------------------------------------------------------------------------------------------------------------------------------- -------------- ----------------- --------------

2.4 Workstream --- Subscriptions, Entitlements & Admin Analytics (added
2026-07-22, not in the original plan)

This work was carved out of the \"Subscription & Billing\" epic in §2.2 once it
became clear that entitlement modelling and payment collection are independent
problems with different blockers. Entitlements are done; payments are not
started and are blocked on infrastructure, not on product decisions.

  ------------------------------ --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- ------------------------------- --------------
  **Deliverable**                **What shipped**                                                                                                                                                                                            **Status**                      **Owner**
  Plans registry                 `src/plans/plans.registry.ts` --- 30 entitlement keys, 3 plans, `formatAmount()`. `plans.service.ts` seeds/reads the `plans` collection **merge-based, so operator edits survive re-seeding**.                **Done --- live in Firestore**  Backend
  Subscription resolution        `subscriptions.service.ts` --- resolves the effective subscription. **Expiry is computed, never trusted**, because nothing rewrites a user doc when a subscription lapses. Falls back to FREE, never to no-access.  **Done**                   Backend
  Entitlements API               `GET /plans`, `POST /plans/seed` (admin), `GET /users/:uid/entitlements`.                                                                                                                                    **Done --- backend only**       Backend
  Admin analytics API            `GET /admin/users`, `GET /admin/subscriptions`, `GET /admin/revenue`. All admin-guarded. **Staff accounts excluded from every metric.**                                                                      **Done --- backend only**       Backend
  Two-layer gating model         FF\_\* release flags (\"is it built?\") kept **separate** from plan entitlements (\"may this tier use it?\"). Both must be true. They render different UI: \"coming soon\" vs \"upgrade to unlock\".          **Done**                        Full Stack
  Frontend entitlement layer     `app/iq/entitlements.tsx` (`EntitlementProvider`, `useSubscription`, `useEntitlement`, `EntitlementGate`) + `entitlement-gate.tsx` (`PlanGate` upgrade panel, `useSlugEntitled` nav hiding).                  **Done --- live**               Frontend
  Admin console on real data     `app/admin/admin-data.ts` builds the dataset from Firestore and stages it in `sessionStorage` before the iframe mounts; `public/admin/console.html` renders it. Fabricated trend deltas and the fake MRR history chart are **suppressed** on real data.  **Done --- live**  Full Stack
  Per-plan feature editor        30 toggles per plan writing to `plans/{id}.featureFlags` (optimistic, reverts on failure). The 2 staff-only keys are shown but **locked**.                                                                    **Done --- live**               Full Stack
  Feature adoption tracking      48 tracked features (screens + in-app actions), 30-second dedupe, failures swallowed so analytics never breaks a screen. Writes client→Firestore directly.                                                    **Done --- live (\~12 rows)**   Full Stack
  Admin Monitor tab              Embeds the backend ops UI, lazily on first visit to the tab.                                                                                                                                                 **Built --- unreachable in prod**  Full Stack
  API usage metering             Specified with rules and a collection; **no middleware records anything**. Admin \"Usage & API\" KPIs read 0.                                                                                                **Not started**                 Backend
  Stripe checkout + webhooks     ---                                                                                                                                                                                                         **Not started --- blocked**     Full Stack
  ------------------------------ --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- ------------------------------- --------------

Plans as they exist in Firestore today. **Amounts are minor units (cents)** ---
4999 = \$49.99. The ladder is cumulative.

  ---------- ----------- ------------ ----------- ------------------ ------------------------------------------------------------------------------------
  **id**     **Name**    **Amount**   **Cycle**   **Entitlements**   **Adds over previous tier**
  free       Free        0            none        8 / 30             marketCatalyst, news, scanner, heatmap, macro, ipos, chartsDaily, watchlist
  plus       Plus        2999 USD     monthly     20 / 30             chartsIntraday, chartsHistory, chartIndicators, chartNotes, technicalRatings, dividendHistory, peers, earningsDetail, portfolio, screener, themes, alerts
  pro        Pro         4999 USD     monthly     28 / 30            fundamentalRatings, ownership, optionsChain, exportData, apiAccess, aiAssistant, backtesting, paperTrading
  ---------- ----------- ------------ ----------- ------------------ ------------------------------------------------------------------------------------

`adminDashboard` and `userManagement` are **staff-only and false on every
plan** --- selling them would be privilege escalation. That is why Pro is
28/30 and not 16/16. `backtesting` and `paperTrading` are granted on Pro but
**not built**, so the two-layer model correctly shows them as \"coming soon\"
rather than as a paywall.

Access control is enforced in the live Firestore ruleset, which is deployed
from **`MarketCatalystUI/firestore.rules`** --- the backend repo\'s copy has
drifted and now carries a DO-NOT-DEPLOY header. `isAdmin()` is
`token.admin == true` **or** `token.email == ADMIN_EMAIL`, and deliberately
does **not** require `email_verified`: the admin is a password account with
`emailVerified=false`, and requiring it locked the admin out of Firestore while
the backend guard still admitted the same account. An admin may update a plan\'s
`featureFlags` + `updatedAt` **only** --- price, currency and cycle are
server-only, and plan create/delete is denied. `feature_adoption` is the only
client-writable analytics collection (necessarily, since the browser cannot
reach the backend) and is constrained so the row must belong to the caller,
`openCount` may only increase, ownership cannot change, and delete is denied.
The same pass fixed two pre-existing bugs: `market_sentiment` and
`stock_comments` had **no rule at all**, so default-deny had been silently
breaking the Dashboard Fear & Greed gauge (it fell back to a hardcoded
62/\"Greed\") and the chart-notes feature.

3\. Milestones

  ----------------------------- ------------ ---------------------- -----------------------------------------------------------------------
  **Milestone**                 **Target**   **Audience**           **Definition of Done**
  Internal Alpha (MVP subset)   Week 6       Engineering team       Dashboard, earnings calendar, movers, auth working end-to-end
  Closed Beta (MVP complete)    Week 18      50 invited users       All 11 MVP features live, real data, basic alerts
  Public Launch --- Pro Tier    Week 22      General public         Stripe billing, Pro features, onboarding flow polished
  Phase 2 Launch                Week 36      Existing subscribers   13F, Options, Copilot, Audio, Story Stocks live; Mobile in TestFlight
  Mobile GA                     Week 42      App stores             iOS + Android apps publicly available with push alerts
  ----------------------------- ------------ ---------------------- -----------------------------------------------------------------------

4\. Team & Resource Plan

  ---------------------- ----------------- ---------------------------------------------------------------------------------
  **Role**               **Headcount**     **Responsibilities**
  Engineering Lead       1 FTE             Architecture, backend data pipeline, API integrations, AI feature orchestration
  Frontend Engineer      2 FTE             React SPA, component library, dashboard, charts, responsive design
  Backend Engineer       1 FTE             WebSocket server, alert engine, recap generation, broker integrations
  AI / Prompt Engineer   0.5 FTE           AI earnings summaries, Copilot prompts, 13F summaries, TA generation
  Mobile Engineer        1 FTE (Phase 2)   React Native app, push notifications, offline states
  Product / Design       1 FTE             UX flows, Figma designs, component specs, user research
  QA Engineer            0.5 FTE           Test plans, regression suites, data accuracy validation
  ---------------------- ----------------- ---------------------------------------------------------------------------------

5\. Technology Stack

Frontend (Current)

-   **Next.js 14 (App Router)** + TypeScript, static export (`output: 'export'`)

-   **Redux Toolkit** for global state (auth slice + profile slice); no Zustand, no React Query

-   **MarketCatalyst custom CSS design system** (`iq.css`) with CSS custom properties — no TailwindCSS for MarketCatalyst screens. Branding: "Stock**Wise**" wordmark with `--ai` cyan accent on "Wise"; logo uses brand→ai gradient with SVG bolt icon.

-   Recharts / D3 for charts and heatmaps (Phase 2 — static data currently)

-   **Firebase Hosting** for static site deployment (project: `fin-app26`)

-   **Firebase Authentication** — email/password + Google OAuth

-   **Cloud Firestore** — user profiles (`users/{uid}`), settings (`settings/{uid}`)

-   **Firestore collections added 2026-07-22** — `intraday_bars` (474 docs),
    `dividend_history` (241), `splits` (241), `plans` (3),
    `feature_adoption` (\~12). Created with rules but **empty**: `payments`,
    `subscriptions`, `api_usage`, `audit_logs`, `revenue_summary`,
    `system_metrics`.

-   **Google Cloud Run** (not AWS ECS) — where the NestJS backend actually
    runs: `us-central1`, `--no-allow-unauthenticated`, `min-instances=0`,
    current revision `market-catalyst-backend-00031-wvc`.

Backend (Planned — Phase 1/2)

-   Node.js + Fastify (API server), Python (data ingestion workers)

-   Firestore (domain document DB), Redis (cache + pub/sub for WS), ClickHouse (time-series market data)

-   BullMQ for background job queues (recap generation, alert dispatch)

-   **Anthropic Claude API** (claude-sonnet-4-6 or latest) for AI summaries, Copilot, TA generation

Infrastructure (Planned)

-   AWS: ECS Fargate (API + workers), ElastiCache Redis, S3 (audio, exports), CloudFront, Route 53

-   Firebase Hosting (frontend — already live), Firebase Authentication + Firestore (auth + data store)

-   Stripe for subscription billing (Free / Pro / Premium tiers)

-   Datadog for observability, PagerDuty for alerting (planned). **Error monitoring is already scaffolded** via Sentry — `@sentry/browser` (frontend, `app/sentry-init.tsx`) + `@sentry/node` (backend, `main.ts`), wired into the error boundaries + process handlers; DSN-gated (no-op until `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` are set).

Data Vendors

-   Polygon.io --- real-time quotes, OHLCV, block trades

-   Financial Modeling Prep --- earnings calendar, fundamentals, sector/group data

-   Benzinga --- news, analyst actions, earnings actuals

-   Unusual Whales API --- options flow and unusual activity

-   SEC EDGAR --- 13F filings (free)

-   Finnhub --- macro/economic calendar

6\. Risks & Mitigations

  ------------------------------------------ ---------------------------------- ---------------- -------------------------------------------------------------------------
  **Risk**                                   **Category**                       **Likelihood**   **Mitigation**
  Real-time data API costs exceed budget     API vendor pricing                 High             Negotiate volume pricing early; add caching layer to reduce call volume
  AI summary latency \>2 min post-earnings   Model inference speed              Medium           Pre-stage prompts; use async queue with in-app loading state
  Earnings transcript availability gaps      Motley Fool / Refinitiv coverage   Medium           Fallback to press release parsing; surface \'transcript pending\' state
  SEC EDGAR rate limits for 13F parsing      EDGAR API limits                   Low              Batch overnight ingestion; cache quarterly filings in own DB
  WebSocket connection drops under load      Infra scalability                  High             Load test to 10k concurrent; implement reconnect with state sync
  ------------------------------------------ ---------------------------------- ---------------- -------------------------------------------------------------------------

7\. Subscription Model

> **⚠ Superseded 2026-07-22.** The Free/Pro/Premium table below is the
> *original* proposal and is no longer what exists. The shipped model is
> **free / plus / pro** with concrete prices (\$0 / \$29.99 / \$49.99 per month,
> stored as minor units) and 16 named entitlement keys --- see §2.4 for the
> authoritative table. Prices are no longer TBD. Two further corrections to the
> table below: \"Real-time data\" is **not** achievable on the current Polygon
> plan (measured delay is exactly 900 s / 15 minutes), and every AI feature
> listed as included is **not built** --- no Claude API call exists in either
> repo. The table is kept for historical context only.

Tier Structure

  ---------- ----------- ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Tier**   **Price**   **Included Features**
  Free       \$0/mo      Delayed data, limited movers view, daily recap (read-only), watchlist up to 5 names, no AI features
  Pro        \$TBD/mo    Real-time data, full movers board, AI earnings summaries, AI technical analysis (4 tone modes), analyst actions board, portfolio/watchlist with 12 alert types, macro dashboard, VIX widget, Before the Bell + After the Close briefings, EOD and weekly recap
  Premium    \$TBD/mo    Everything in Pro plus: 13F intelligence with AI summaries, unusual options activity, block trades, AI Market Copilot, audio recaps, expanded alerts (SMS + push), industry rotation alerts, story stocks, social sharing, weekly deep recap with portfolio view
  ---------- ----------- ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

8\. Definition of Done --- MVP

-   All 11 MVP features have passed QA and are deployed to production

-   Real-time data latency \< 1 second (WebSocket feed)

-   Page load time \< 2 seconds on desktop (LCP)

-   AI earnings summaries generated within 5 minutes of transcript availability

-   Email alert delivery \< 60 seconds from event trigger

-   50 beta users onboarded with at least 10 active daily users

-   No P0/P1 bugs open at launch

-   Stripe billing live with Free and Pro tiers gated

Status against these criteria as of 2026-07-22: tier **gating** is met (§2.4);
Stripe **billing** is not started. \"Real-time data latency \< 1 second\" is
unreachable on the current vendor plan (900 s delay, measured) and needs
restating or a plan upgrade. The AI-summary and email-alert criteria have no
implementation behind them at all.

9\. Known Gaps (verified 2026-07-22)

These are stated plainly rather than folded into status percentages. Items 1
and 2 are infrastructure and gate several \"finished\" features.

1.  **The browser cannot reach the backend.** `NEXT_PUBLIC_BACKEND_URL` is
    unset, so `http://localhost:4100` is compiled into the production bundle
    and blocked as mixed content. This disables in production: the admin
    Monitor tab, extended-hours moves, the vendor market-status pill, and any
    future Stripe checkout/webhook. The fix is a Firebase Hosting rewrite →
    Cloud Run, which **requires** setting `ADMIN_GUARD_TRUST_IAM=false` first
    --- otherwise `/sync/:job/run`, `/purge` and `/retention` become
    world-callable.

2.  **No scheduled data refresh exists.** No Cloud Scheduler jobs in any
    region, no `scheduler-invoker` service account; `create-scheduler-jobs.sh`
    was never run. With `min-instances=0` the in-process `@Cron` decorators
    never fire, so **no sync job has ever run automatically in production** ---
    every row in Firestore came from a manual run.

3.  **`POLYGON_API_KEY` is un-rotated.** It was exposed in chat. Secret Manager
    version 4 is enabled. `deploy/rotate-polygon-key.sh` automates the whole
    rotation except generating the replacement key.

4.  **Stripe is not implemented.** No Stripe code in either repo; `payments`
    and `subscriptions` are empty collections. Blocked additionally on gap 1.

5.  **`api_usage` is specified but not implemented.** No middleware records API
    calls, so the admin \"Usage & API\" KPIs read 0. Those tiles mean \"not
    instrumented\", not \"no traffic\".

6.  **Per-user engagement columns are empty.** watchlists / holdings /
    apiCalls / alerts in the admin Users view render 0 --- there is no
    collection behind them yet.

7.  **AI features are all unbuilt.** Every AI surface in the product (earnings
    summaries, technical analysis, portfolio pulse, Copilot, story stocks,
    analyst notes) renders hand-written static prose. Backtesting and paper
    trading are likewise granted as Pro entitlements but not implemented.

8.  **Options greeks, IV, open interest and bid/ask are vendor-blocked.** The
    Polygon options snapshot endpoint returns 403 `NOT_AUTHORIZED` on the
    current plan; those columns are seeded pseudo-random values. Also
    unavailable: index values (I:SPX, I:VIX), trades/quotes/last-trade,
    Benzinga endpoints, `/v1/summaries`; 404 on short-interest and futures.

9.  **The two repos\' `firestore.rules` have drifted.** The **live** ruleset is
    deployed from `MarketCatalystUI/firestore.rules`; the backend copy is stale
    and now carries a DO-NOT-DEPLOY header.

Current deployment: backend on Cloud Run revision
`market-catalyst-backend-00031-wvc` (us-central1,
`--no-allow-unauthenticated`, `min-instances=0`); frontend at
<https://marketcatalyst.web.app> (Firebase Hosting, static export); Firestore
rules released.
