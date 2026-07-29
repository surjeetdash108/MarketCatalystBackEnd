# MarketCatalyst — Task Tracker

> ## ⏱ State sync — 2026-07-27 · TWO ENVIRONMENTS (stage + prod), env-driven config
>
> _This block is newest and authoritative where it differs from the blocks
> below. It introduces a second, fully-isolated environment; nothing about the
> per-environment runtime topology (§6, the on-demand data layer, the CDN
> rewrite) changes — that topology now simply exists twice, once per project._
>
> **This doc, specifically:** Add an open task — wire stage's Firebase Hosting
> rewrites (`/api`, `/market-data`, `/live` → the stage `market-catalyst-live`
> service) once stage billing is linked; every other tracked task is unchanged.
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
> · local dev (`localhost`/`127.0.0.1`) → `http://localhost:4100`;
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
> **This doc, specifically:** For tasks: the ingestion + UI tasks are done; the open ones are the AI features (R35/R36) and Benzinga-gated estimates.
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

v1.5 | June 2026

> **⚠ Implementation status (updated 2026-07-22; previously 2026-07-09, first noted 2026-07-05):**
> Nearly every infra task below (AWS VPC, ECS, Redis, ClickHouse, Stripe,
> Fastify, WebSocket gateway) describes a stack that was never built and
> isn't planned to be — the actual backend is a single NestJS service
> (`backend/`) using `@nestjs/schedule` cron jobs (**23 as of 2026-07-22**,
> roughly one per collection) writing directly to Cloud Firestore, with no
> AWS/ECS/Redis/ClickHouse/BullMQ/Stripe/Fastify/WebSocket layer anywhere.
> For what's actually implemented and what's genuinely still pending — including
> the live in-session task board this file doesn't reflect — see
> `Doc/openapi.yaml` (per-endpoint `x-status: live|planned`), `Doc/schema.sql`,
> `Doc/screen-data-sources.md`, and `Doc/DELIVERY-PLAN-STATUS.md`.
> Sections **T-143 onward are current and authoritative**; everything before
> them is retained for historical planning context.

> **⚠ Read before trusting any "Done" below.** Two production-wide conditions
> mean *code complete ≠ working for a user*:
> **(1)** There are **no Cloud Scheduler jobs in any region** and Cloud Run runs
> at `min-instances=0`, so the `@Cron` decorators never fire — **no sync job has
> ever run automatically in production**; all data came from manual runs.
> **(2)** The **browser cannot reach the backend** (`NEXT_PUBLIC_BACKEND_URL`
> unset → `http://localhost:4100` baked into the production bundle, blocked as
> mixed content). See T-148a–d.

**Status:** Not Started | In Progress | In Review | Done  
**Status semantics (tightened 2026-07-22 — applied to T-143 onward):**  
&nbsp;&nbsp;• **Done** = LIVE. Deployed *and* exercisable by a real user in production.  
&nbsp;&nbsp;• **In Review** = BUILT-NOT-LIVE. Code is written and deployed but production cannot execute or reach it. Notes must start with `⚠ BUILT, NOT LIVE —` and give the reason.  
&nbsp;&nbsp;• **Not Started** = NOT BUILT. No implementation exists.  
**Priority:** P0 = MVP blocker | P1 = high quality | P2 = nice to have  
**Est.** = engineering days (sub-tasks are ≤ 0.5d each)  
**ID convention:** T-NNN = original task; T-NNNa / T-NNNb = granular sub-tasks

---

## Infrastructure & Data

### Core Infrastructure

#### AWS VPC & Networking

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-001a | Create AWS VPC (10.0.0.0/16); 2 public subnets (ALB, NAT) + 2 private subnets (ECS, Redis) across us-east-1a and us-east-1b | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | Enable DNS hostnames; private subnets route outbound through NAT Gateway |
| T-001b | Create security groups: alb-sg (443/80 from internet), ecs-api-sg (3000 from ALB only), ecs-ws-sg (3001 from ALB only), redis-sg (6379 from ECS only) | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | No 0.0.0.0 inbound on private SGs |
| T-001c | Create IAM roles: ECS task-execution role (ECR pull + Secrets Manager read), ECS task role (Firestore SA + S3 write), CI deploy role (ECR push + ECS update-service) | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | Least-privilege; no wildcard Action |

#### Firebase Backend

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-002a | Enable Firestore (Native mode) in Firebase project fin-app26, us-east1 region | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | Native mode required — not Datastore mode |
| T-002b | Create Firebase service account key; store JSON in AWS Secrets Manager as `firebase-service-account` | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | SA needs Firestore read/write + Auth admin roles |
| T-002c | Inject secret into ECS env var; verify Admin SDK `admin.firestore().collection('test').get()` health check from api-service container | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | Already done for frontend; this is server-side |
| T-079 | Migrate state management from Zustand+React Query to Redux Toolkit: auth-slice, profile-slice, FirebaseListener, ReduxProvider, typed hooks | Frontend | 2d | P0 | FE Eng 1 | S-02 | **Done** | store.ts + slices + firebase-listener.tsx + hooks.ts. `authStateReady()` before subscribing. |
| T-080 | Replace Vite + React SPA with Next.js App Router (static export). Firebase Hosting. | Infra | 2d | P0 | Infra Eng | S-01 | **Done** | fin-app26. `firebase deploy --only hosting`. |
| T-093 | Add Firestore settings/{uid} security rule; deploy firestore.rules | Infra | 0.5d | P0 | Infra Eng | S-03 | **Done** | `match /settings/{uid} { allow read, write: if isOwner(uid); }` |

#### Redis

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-003a | Provision ElastiCache Redis (cache.r6g.large), Multi-AZ failover; store AUTH token in Secrets Manager | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | Used for: BullMQ queues, pub/sub, quote cache (TTL 5s), session store |
| T-003b | Configure Redis SG + subnet group; verify connectivity from ECS private subnet with `redis-cli PING` | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | Inbound 6379 from ecs-api-sg + ecs-ws-sg only |

#### ClickHouse

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-004a | Provision EC2 r6i.2xlarge; install ClickHouse; configure gp3 500GB storage; restrict ports 9000/8123 to private VPC | Infra | 0.5d | P0 | Backend | S-01 | Not Started | Single node MVP; cluster in Phase 2 |
| T-004b | Create `quotes` table (ReplacingMergeTree, partition by month, order by sym+ts); create `daily_ohlcv` materialized view for per-day aggregates | Backend | 0.5d | P0 | Backend | S-01 | Not Started | ReplacingMergeTree deduplicates real-time tick re-delivery |
| T-004c | Build internal ClickHouse microservice (Fastify port 3002): `GET /ohlcv?sym=&from=&to=` and `GET /movers?date=`; used only by api-service | Backend | 0.5d | P0 | Backend | S-01 | Not Started | Wraps ClickHouse HTTP; adds internal auth header check |

#### ECS

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-005a | Create ECS cluster; task definition for api-service (Fargate, 1vCPU/2GB, port 3000); ALB target group + listener rule; health check `GET /health → 200` | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | |
| T-005b | Task definitions for websocket-service (port 3001) and each ingestion worker (quote, news, earnings, analyst, macro) | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | Workers have no ALB; one task per definition |
| T-005c | ECS auto-scaling for api-service + ws-service: scale out CPU > 60%; min 2 tasks, max 10 | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | Target-tracking policy on ECS Application Auto Scaling |

#### CI/CD

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-006a | Frontend pipeline (GitHub Actions): install → lint → `next build` → `firebase deploy --only hosting` on push to main | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | Cache node_modules; use FIREBASE_TOKEN secret |
| T-006b | Backend API pipeline: lint → test → docker build → ECR push → `aws ecs update-service --force-new-deployment` for api + ws services | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | Tag image with git SHA; separate jobs per service |
| T-006c | Worker pipeline: lint → docker build → ECR push only (workers deploy manually, not auto-deployed on push) | Infra | 0.5d | P0 | Infra Eng | S-01 | Not Started | Workers have longer release cycles |

#### Firestore Schema

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-009a | Define + document collections: `users/{uid}` (name/email/tier/createdAt), `users/{uid}/portfolios/{id}` (holdings[]), `users/{uid}/watchlists/{id}` (symbols[]) | Backend | 0.5d | P0 | Backend | S-01 | Not Started | Firebase-generated IDs; soft deletes via deletedAt field |
| T-009b | Define alert + notification sub-collections: `users/{uid}/alerts/{id}` (type/threshold/channels/enabled), `users/{uid}/notifications/{id}` (type/read/createdAt) | Backend | 0.5d | P0 | Backend | S-01 | Not Started | Notification unread count drives badge in shell topbar |
| T-009c | Write firestore.rules: `isOwner()` helper; rules for users, settings, portfolios, watchlists, alerts, notifications, stock_comments | Backend | 0.5d | P0 | Backend | S-01 | Not Started | No public reads; all require isOwner(uid) |
| T-009d | Define composite indexes in firestore.indexes.json: stock_comments (uid+sym+createdAt), notifications (uid+read+createdAt). Deploy `firebase deploy --only firestore:indexes` | Backend | 0.5d | P0 | Backend | S-01 | Not Started | Required for compound queries |

#### Firestore Rules — Missing-Rule Bugs & Drift (2026-07-22)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-145a | Add `market_sentiment` security rule (public read, server-only write); deploy ruleset | Backend | 0.25d | P0 | Backend | S-13 | **Done** | 🐛 **Bug fix, not a feature.** The collection had **no rule at all**, so default-deny silently blocked the read and the Dashboard Fear & Greed gauge fell through to a **hardcoded 62 / "Greed"** for every user. Data had been correct in Firestore since 07-21 — nobody could see it. Gauge now reads live. |
| T-145b | Add `stock_comments` security rule (`isOwner(uid)`); deploy ruleset | Backend | 0.25d | P0 | Backend | S-13 | **Done** | 🐛 Same class of bug — no rule existed, so the chart-notes feature (T-112) was silently dead in production despite being marked Done since S-08. |
| T-145c | Add DO-NOT-DEPLOY header to the stale backend `firestore.rules` copy | Backend | 0.25d | P0 | Backend | S-13 | **Done** | Both repos ship a `firestore.rules` and they have **drifted**. The LIVE ruleset deploys from `MarketCatalystUI/firestore.rules`. The backend copy is stale; header added so it is never deployed by mistake. |
| T-145d | Reconcile the two `firestore.rules` copies into a single source of truth (delete or symlink the backend copy; document the deploy path in the release checklist) | Backend | 0.5d | P0 | Backend | S-13 | Not Started | T-145c is a guardrail, not a fix. Two divergent rulesets in two repos is how T-145a/T-145b happened in the first place. |
| T-145e | Rules for the subscription/analytics collections: `plans` (admin may write **`featureFlags`+`updatedAt` ONLY**, create/delete denied), `payments`/`subscriptions` (admin reads all, user reads own), `api_usage`/`feature_adoption`/`audit_logs`/`revenue_summary`/`system_metrics` (admin read), `users` (owner OR admin read) | Backend | 0.5d | P0 | Backend | S-13 | **Done** | Price/currency/cycle are deliberately server-only — a client able to rewrite `amount` could set a plan to $0. `feature_adoption` is the **only** client-writable analytics collection (forced by the browser↔backend gap, T-148b) and is constrained: row must belong to caller, `openCount` may only INCREASE, ownership immutable, delete denied. |
| T-145f | `isAdmin()` helper: `token.admin == true` **OR** `token.email == ADMIN_EMAIL`, deliberately **without** an `email_verified` requirement | Backend | 0.25d | P0 | Backend | S-13 | **Done** | ⚠ Intentional and load-bearing — do not "harden" this back. The admin is a password account with `emailVerified=false`; requiring verification locked the admin out of Firestore while the backend guard still admitted the same account. |

#### Operations — Scheduling & Reachability (2026-07-22)

> These four are the highest-value open items in this file. None needs a vendor
> purchase or new feature code; together they are the difference between "the
> code exists" and "the product runs".

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-148a | Run `create-scheduler-jobs.sh`: create Cloud Scheduler jobs for all sync jobs + create the `scheduler-invoker` service account + grant it `run.invoker` | Infra | 0.5d | P0 | Infra Eng | S-13 | Not Started | 🔴 **Nothing refreshes automatically in production.** No Cloud Scheduler jobs exist in **any** region and no `scheduler-invoker` SA exists — the script was never run. With `min-instances=0` the in-process `@Cron` decorators never fire. Every populated collection is frozen at its last **manual** run. |
| T-148b | Firebase Hosting rewrite → Cloud Run so the browser can reach the backend; set `NEXT_PUBLIC_BACKEND_URL` and rebuild the bundle | Infra | 0.5d | P0 | Infra Eng | S-13 | Not Started | 🔴 `NEXT_PUBLIC_BACKEND_URL` is unset, so `http://localhost:4100` is baked into the production bundle and blocked as mixed content. Disables in prod: admin **Monitor** tab, extended-hours moves, market-status pill, all `/plans` + `/admin/*` endpoints, and any future Stripe checkout/webhook. **Blocked on T-148c — do not do this first.** |
| T-148c | Set `ADMIN_GUARD_TRUST_IAM=false` **before** T-148b | Infra | 0.25d | P0 | Infra Eng | S-13 | Not Started | ⚠ **Ordering is a security requirement.** Cloud Run currently runs `--no-allow-unauthenticated`, so IAM is the guard. The moment a Hosting rewrite fronts it, `/sync/:job/run`, `/purge` and `/retention` become world-callable unless this flag is flipped first. |
| T-148d | Rotate `POLYGON_API_KEY` (exposed in chat, never rotated) | Infra | 0.25d | P0 | Infra Eng | S-13 | Not Started | Secret Manager version 4 is enabled. `deploy/rotate-polygon-key.sh` automates everything **except** generating the replacement key at Polygon — that step is manual and must be done by the account holder. |

#### Stripe

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-010a | Create Stripe account; define Free/Pro ($29/mo)/Premium ($79/mo) products + prices; enable Customer Portal | Backend | 0.5d | P1 | Backend | S-02 | Not Started | Add monthly + annual billing options per tier |
| T-010b | Implement Stripe webhook handler: `checkout.session.completed` → set Firestore users/{uid}.tier; `subscription.updated/deleted` → update/downgrade tier | Backend | 0.5d | P1 | Backend | S-02 | Not Started | Verify `Stripe-Signature` header; use idempotency key per event ID |

---

### Data Ingestion

#### Polygon.io — Real-time Quotes

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-011a | Build Polygon WebSocket connection manager: connect to `wss://socket.polygon.io/stocks`, authenticate, subscribe to `A.*` (per-second aggregates) | Backend | 0.5d | P0 | Backend | S-02 | Not Started | Reconnect backoff: 1s → 2s → 4s → 8s → max 60s |
| T-011b | Write quote normalizer: map Polygon `A.*` → `{sym,o,h,l,c,v,ts}`; batch MSET to Redis `q:{sym}` TTL 5s every 500ms | Backend | 0.5d | P0 | Backend | S-02 | Not Started | Batch writes reduce Redis ops by ~80% vs per-message |
| T-011c | Dead-letter handling: 3 consecutive write failures for a sym → append to Redis list `dead_letter:quotes:{sym}`; alert if list length > 10 | Backend | 0.5d | P0 | Backend | S-02 | Not Started | Ops review via Slack webhook |

#### Polygon.io — OHLCV Historical

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-012a | Build OHLCV REST fetcher: `GET /v2/aggs/ticker/{sym}/range/1/day/{from}/{to}`; normalize to ClickHouse schema `{sym,date,o,h,l,c,v,vwap}` | Backend | 0.5d | P0 | Backend | S-02 | Not Started | Throttle: 5 req/s; use BullMQ rate-limited queue |
| T-012b | ClickHouse bulk insert worker: batch 1000 rows per INSERT; ReplacingMergeTree handles deduplication on re-run | Backend | 0.5d | P0 | Backend | S-02 | Not Started | Use ClickHouse HTTP bulk endpoint for throughput |
| T-012c | 2-year backfill script: for each symbol in watch universe, fetch last 500 trading days; mark sym as backfilled in Redis `backfill:{sym}`; skip if already done | Backend | 0.5d | P0 | Backend | S-02 | Not Started | One-time run on first deploy; ~2h for 500 symbols |

#### Polygon.io — Deep Data Wiring (2026-07-22, rev 00031-wvc)

> Supersedes the ClickHouse/Redis design in T-011/T-012 above. All of this
> writes directly to Firestore from `@nestjs/schedule` jobs. Every job below is
> **Done = code live on Cloud Run and data verified present in production
> Firestore** — but see T-148a: none of them fires on a schedule yet.

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-143a | New `src/sync/intraday-bars.job.ts`: fetch 5-min + 30-min aggregates → `intraday_bars/{ticker}_{5min\|30min}`; cron `25 16 * * 1-5` ET | Backend | 1d | P0 | Backend | S-13 | **Done** | 474 docs in prod. **One doc per ticker/resolution holding an ARRAY of bars** — not a doc per bar (deliberate: keeps read cost at 1 doc per chart load). Unblocks the 1D/1W chart timeframes. |
| T-143b | New `src/sync/corporate-actions.job.ts`: `dividend_history/{ticker}` + `splits/{ticker}`; cron `40 6 * * *` ET | Backend | 1d | P0 | Backend | S-13 | **Done** | 241 docs each in prod. `dividend_history` carries full payment history, annual totals, TTM total, derived yield, 5-year CAGR and increase streak — all computed at sync time so the client does no aggregation. |
| T-143c | `stock-history.job.ts`: raise backfill 300 days → **5 years** (clamped to the plan's rolling 5-year edge); add `earliestSyncedFrom` watermark; persist `vwap` per bar | Backend | 1d | P0 | Backend | S-13 | **Done** | ⚠ **Raising the constant alone did nothing** — `lastSyncedThrough` only ever advances, so the job could never reach *older* data. The `earliestSyncedFrom` watermark makes history fill **backwards** as well as forwards. `ohlcv_bars` now holds **~299,552 docs** across the full 5-year window. Unblocks the 5Y chart timeframe. |
| T-143d | `technical-indicators.job.ts`: add `rsi14Series` (90-point rolling), `smaLadder`/`emaLadder` (10/20/30/50/100/200), `vwap`, `high52`/`low52`, `pctFromHigh52`/`pctFromLow52`, `avgVolume20`/`avgVolume50`, `barsAnalyzed` | Backend | 1d | P0 | Backend | S-13 | **Done** | Only became computable once T-143c gave the job 5 years of bars to work from. |
| T-143e | `financials.job.ts`: store balance sheet + cash flow + margins + current ratio | Backend | 0.5d | P0 | Backend | S-13 | **Done** | The job was already **fetching these and discarding them** — it only persisted the income-statement fields. Now stored; backs the full fundamentals panel, not just EPS history. |
| T-143f | `options-chains.job.ts`: per-contract full OHLC, VWAP, trade count, range % | Backend | 0.5d | P1 | Backend | S-13 | **Done** | ⚠ Scope this narrowly: option **contract aggregates** are authorized on the plan, so traded price/volume history per contract is now **real**. The options **snapshot** endpoint (greeks/IV/OI/bid-ask) is still `NOT_AUTHORIZED` — see T-132a–d. |
| T-143g | `market-indices.job.ts`: source US10Y from `/fed/v1/treasury-yields`; set `isProxy:false`, `unit:"percent"` | Backend | 0.5d | P0 | Backend | S-13 | **Done** | 🐛 **Correctness fix, not an upgrade.** US10Y was previously the **TLT ETF price**, which moves *inversely* to the yield it was labelled as — the card showed the yield falling when it was rising. Now the real Treasury yield. |
| T-143h | `src/live/snapshot-cache.service.ts`: v2 → **v3 universal snapshot**; add `earlyTradingChangePct` / `lateTradingChangePct` / `regularTradingChangePct` / `marketStatus` | Backend | 0.5d | P0 | Backend | S-13 | **Done** | Splits a single day-change number into pre-market / regular / after-hours components. |
| T-143i | New `src/live/market-status.service.ts` + `GET /live/market-status` | Backend | 0.5d | P1 | Backend | S-13 | **In Review** | ⚠ BUILT, NOT LIVE — endpoint is deployed on rev 00031-wvc but the browser cannot reach the backend (T-148b), so the vendor market-status pill never renders in production. |
| T-143j | `src/vendors/polygon/polygon.service.ts`: add `getIntradayBars`, `getRelatedCompanies`, `getDividendHistory`, `getSplits`, `getMarketStatus`, `getUpcomingMarketHolidays`, `getTreasuryYields`, `getUniversalSnapshot`, `getFinancialStatements`, `planHistoryFloor()` | Backend | 1d | P0 | Backend | S-13 | **Done** | `planHistoryFloor()` centralises the measured 5-year edge so no caller requests data the plan will 403 on. |
| T-143k | `polygon-company-profile.adapter.ts`: populate `peers` (`/v1/related-companies`), `dividendYield`, `dividendPerShare` | Backend | 0.5d | P1 | Backend | S-13 | **Done** | These three were previously declared `FIELD_NOT_SUPPORTED` — **that was wrong**; all three are authorized on the current plan. Unblocks the Stock Detail peer table (T-043a) at the data layer. |
| T-143L | Probe and document actual Polygon plan entitlements (Stocks Starter) | Backend | 0.5d | P0 | Backend | S-13 | **Done** | ✅ Authorized: daily + intraday aggs, 5-year history, grouped daily, v2/v3 snapshots, reference tickers/dividends/splits/IPOs/news, `/v1/related-companies`, `/v1/indicators/*`, `/v1/marketstatus/*`, `/vX/reference/financials`, option **contract** aggs, `/fed/v1/*`. ❌ 403: options snapshot (greeks/IV/OI/bid-ask), index values (`I:SPX`, `I:VIX`), trades/quotes/last-trade, `/benzinga/v1/*`, `/v1/summaries`. ❌ 404: short-interest, futures. **Measured: exactly 900 s (15 min) delay, exactly 5-year rolling history.** Re-probe rather than assume — T-143k and the R24 chart gap were both caused by assumed, not measured, limits. |

#### Benzinga — News

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-013a | Build Benzinga News WebSocket connector: connect to `wss://api.benzinga.com/api/v1/news/stream`; authenticate via `X-API-KEY`; handle reconnect; fall back to REST poll if WS down > 30s | Backend | 0.5d | P0 | Backend | S-02 | Not Started | |
| T-013b | News normalizer: map Benzinga payload → `{id,syms[],headline,body,source,category,publishedAt}`; classify category (Macro/Earnings/Analyst/Story) from Benzinga `channels` field | Backend | 0.5d | P0 | Backend | S-02 | Not Started | category = Earnings if channels includes "earnings", Analyst if "analyst-ratings" |
| T-013c | Write to Firestore `news/{id}`; publish to Redis pub/sub channel `feed:all` | Backend | 0.5d | P0 | Backend | S-02 | Not Started | Include `syms[]` field for per-ticker filtering by WebSocket gateway |

#### FMP — Earnings Calendar

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-014a | Build FMP Earnings Calendar 15-min poll: `GET /api/v3/earning_calendar?from=&to=`; upsert Firestore `earnings_events` on ticker+date key | Backend | 0.5d | P0 | Backend | S-02 | Not Started | BullMQ repeatable job; fetch 7-day window around today |
| T-014b | Earnings result handler: when `epsActual` is populated (new vs prior fetch), publish to Redis `earnings:result` channel; enqueue AI summary BullMQ job | Backend | 0.5d | P0 | Backend | S-02 | Not Started | Detect result by comparing consecutive fetches |

#### Benzinga — Analyst Actions

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-015a | Build Benzinga Analyst API 5-min poll: `GET /api/v2/analyst/ratings?pageSize=50`; normalize to `{sym,firm,prevRating,newRating,prevPT,newPT,action,publishedAt}` | Backend | 0.5d | P0 | Backend | S-02 | Not Started | Deduplicate by sym+firm+publishedAt composite key |
| T-015b | Write to Firestore `analyst_actions`; publish to Redis `feed:analyst_actions` pub/sub channel | Backend | 0.5d | P0 | Backend | S-02 | Not Started | WS gateway fans out to clients subscribed to feed:all |

#### Finnhub — Economic Calendar

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-016a | Build Finnhub daily cron (6am ET): `GET /api/v1/calendar/economic`; normalize to `{event,date,time,importance,prev,est,actual,country}` | Backend | 0.5d | P1 | Backend | S-03 | Not Started | Importance: 3=High, 2=Medium, 1=Low |
| T-016b | Upsert to Firestore `macro_events`; overwrite on event+date composite key | Backend | 0.5d | P1 | Backend | S-03 | Not Started | |

#### EDGAR 13F (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-017a | Build EDGAR full-text index poller: detect new 13F-HR filings nightly; compare to cached last-seen filing date per CIK | Backend | 0.5d | P0 | Backend | S-10 | Not Started | Phase 2 |
| T-017b | Build 13F XML parser: extract fund name, report date, all holdings (CUSIP, value, shares) from primary document; handle both 13F-HR and 13F-HR/A schemas | Backend | 1d | P0 | Backend | S-10 | Not Started | Phase 2; most complex parsing step |
| T-017c | Load to Firestore `fund_holdings/{CIK}/{quarter}/{CUSIP}`; compute delta vs prior quarter (new/added/trimmed/exited/unchanged) | Backend | 0.5d | P0 | Backend | S-10 | Not Started | Phase 2; delta type stored for AI summary input |

#### Unusual Whales — Options (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-018a | Build Unusual Whales WebSocket connector + normalizer: map to `{sym,type,strike,expiry,premium,contracts,totalValue,sentiment}` | Backend | 0.5d | P0 | Backend | S-11 | Not Started | Phase 2 |
| T-018b | Flag sentiment (bullish/bearish/unclear): call OTM% > 10% + call + large premium = bullish; put + ITM = bearish | Backend | 0.5d | P0 | Backend | S-11 | Not Started | Phase 2 |

#### Polygon — Block Trades (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-019a | Subscribe to Polygon `T.*` stream; filter trade > $500k or > 10k shares; compute vs-VWAP from Redis quote cache; write to Firestore `block_trades` | Backend | 0.5d | P1 | Backend | S-11 | Not Started | Phase 2 |

---

## Pre-App

### Landing Page — `/`

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-102 | Build MarketCatalyst marketing landing page: hw-* sections, scroll-reveal, inline login modal, landing.css | Frontend | 3d | P0 | FE Eng 1 | S-02 | **Done** | `app/page.tsx` + `app/landing.css`. All animations present. |

### Auth Pages — `/auth/*`

#### Firebase Auth Setup

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-007a | Enable email/password + Google OAuth in Firebase console; add production + localhost authorized domains | Auth | 0.5d | P0 | Backend | S-01 | Not Started | |
| T-007b | Add Firebase service account to Secrets Manager; verify `admin.auth().verifyIdToken()` works from api-service container with a real ID token | Auth | 0.5d | P0 | Backend | S-01 | Not Started | |

#### API Auth Middleware

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-008a | Build Fastify auth middleware: extract Bearer token from Authorization header; call `verifyIdToken()`; attach uid to request context; return 401 if missing, 403 if invalid | Backend | 0.5d | P0 | Backend | S-01 | Not Started | Apply to all `/api/v1/*` routes |
| T-008b | Extend middleware: after token verify, read `users/{uid}.tier` from Firestore; attach tier to context; cache tier in Redis TTL 5min to avoid per-request Firestore read | Backend | 0.5d | P0 | Backend | S-01 | Not Started | Tier used for rate limiting + feature gating |

#### Auth UI (Done)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-081 | Redesign auth pages to MarketCatalyst dark theme: two-panel AuthLayout, CSS variables, Google + email/password | Frontend | 2d | P0 | FE Eng 1 | S-02 | **Done** | auth-layout.tsx + login/signup/forgot forms. |
| T-103 | Fix auth routing: modal logo → close modal, signup "Sign in" → `/`, forgot "Back" → `/` | Frontend | 0.5d | P0 | FE Eng 1 | S-02 | **Done** | All auth pages return to / (landing). |

---

## Intelligence

### Dashboard — `/dashboard`

#### Done

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-021 | Remove session filter tabs from Dashboard header | Frontend | 0d | P0 | FE Eng 1 | S-03 | **Done** | Only "✦ AI Summary" button remains. |
| T-084 | Build Dashboard screen (static data): all widgets | Frontend | 2d | P0 | FE Eng 1 | S-04 | **Done** | screens/dashboard.tsx. openStock/openEarnings via IQActionsContext. |
| T-097 | Add IndexDrawer + FearGreedDrawer to IQShell | Frontend | 1d | P0 | FE Eng 1 | S-08 | **Done** | shell.tsx. openIndex(i) + openFearGreed() wired to pulse cards + F&G widget. |
| T-098 | Rewrite Dashboard to HTML-parity col-4/col-8 grid layout | Frontend | 1d | P0 | FE Eng 1 | S-04 | **Done** | screens/dashboard.tsx. |
| T-104 | Replace right-side drawer with centered modal/popover (iq-popIn animation) | Frontend | 0.5d | P0 | FE Eng 1 | S-08 | **Done** | app/iq.css. |
| T-105 | Dashboard Market Movers widget: Winners/Losers tabs + Technical/News hover popup | Frontend | 1d | P0 | FE Eng 1 | S-08 | **Done** | screens/dashboard.tsx + app/iq.css. |
| T-106 | Dashboard Market Movers sector + cap filter dropdowns | Frontend | 0.5d | P1 | FE Eng 1 | S-08 | **Done** | screens/dashboard.tsx. |
| T-107 | Dashboard Trending Stocks col-12 widget with computeTrending() | Frontend | 0.5d | P1 | FE Eng 1 | S-08 | **Done** | screens/dashboard.tsx. |

#### Live Dashboard — Market Pulse

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-020a | Subscribe Pulse strip to WebSocket `quotes:{sym}` for S&P, Nasdaq, Dow, Russell, VIX, 10Y yield, crude, gold, DXY, BTC; update state on message | Frontend | 0.5d | P0 | FE Eng 1 | S-03 | Not Started | Unsubscribe on unmount; show last known value on reconnect |
| T-020b | Color-code and animate Pulse tiles: green > 0, red < 0; CSS flash transition 500ms on value change | Frontend | 0.5d | P0 | FE Eng 1 | S-03 | Not Started | |

#### Live Dashboard — Widget Grid

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-022a | Install react-grid-layout; wrap Dashboard widgets in GridLayout (12-col); default layout matches current static grid; persist layout JSON to Firestore `settings/{uid}.dashLayout` | Frontend | 1d | P0 | FE Eng 2 | S-03 | Not Started | |
| T-022b | Build widget add/remove panel: list of 8 available widget types; toggle on/off; "Reset to default" button | Frontend | 0.5d | P0 | FE Eng 2 | S-03 | Not Started | |

#### Live Dashboard — What Matters Now

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-023a | WMN card skeleton loader: 3 shimmer cards while fetching; never show empty state | Frontend | 0.5d | P0 | FE Eng 1 | S-04 | Not Started | |
| T-023b | Poll `GET /api/v1/wmn` every 5 min; replace card content on update; show "updated X min ago" | Frontend | 0.5d | P0 | FE Eng 1 | S-04 | Not Started | setInterval with cleanup on unmount |
| T-024a | Build WMN Claude prompt: inject top 3 movers + top 2 analyst actions + earnings today + macro today + portfolio day-change; structured JSON output `[{headline,body,type,sym}]` | Backend | 0.5d | P0 | Backend | S-04 | Not Started | Max 3000 token input |
| T-024b | BullMQ repeatable job: run every 10 min during market hours `*/10 9-16 * * 1-5` ET; store result in Firestore `wmn/{date}` | Backend | 0.5d | P0 | Backend | S-04 | Not Started | |

#### Live Dashboard — Live Feed

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-047a | Connect LiveFeed to WebSocket `feed:all`; maintain rolling array of last 50 items in state; prepend on new message | Frontend | 0.5d | P0 | FE Eng 2 | S-03 | Not Started | |
| T-047b | Build FeedCard: category pill (color by type), time, headline, "Why it matters", pin icon, mark-read dot | Frontend | 0.5d | P0 | FE Eng 2 | S-03 | Not Started | Earnings=brand, Analyst=ai, Macro=warn, Story=up |
| T-047c | Feed filter tabs: Live (all), Portfolio (filter by Redux holdings/watchlist syms), Earnings, Analyst, Macro | Frontend | 0.5d | P0 | FE Eng 2 | S-03 | Not Started | |

#### Live Dashboard — WebSocket Gateway

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-048a | Build WebSocket gateway (Fastify ws upgrade): authenticate on connection via Firebase ID token in first message; map socket → {uid, subscribedChannels} | Backend | 0.5d | P0 | Backend | S-02 | Not Started | |
| T-048b | Subscribe gateway to all Redis pub/sub channels; fan-out messages to matching clients with `channel` field routing | Backend | 0.5d | P0 | Backend | S-02 | Not Started | Redis reconnect on failure; re-subscribe all channels |

#### Live Dashboard — Briefings

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-060a | Before the Bell data collector: cron `30 8 * * 1-5` ET; fetch futures from Redis + overnight news from Firestore + macro events today + BMO earnings | Backend | 0.5d | P0 | Backend | S-04 | Not Started | |
| T-060b | Call Claude with Before the Bell data; store in Firestore `briefings/{date}/beforebell`; publish to Redis `briefings` channel; send email to opted-in users | Backend | 0.5d | P0 | Backend | S-04 | Not Started | Prompt: "150 words: what to know before market opens" |
| T-061a | After the Close data collector: cron `0 17 * * 1-5` ET; fetch final index prices + top stories + next-day earnings + macro | Backend | 0.5d | P0 | Backend | S-04 | Not Started | |
| T-061b | Call Claude for After the Close summary; store in Firestore `briefings/{date}/afterclose`; trigger SendGrid email dispatch | Backend | 0.5d | P0 | Backend | S-04 | Not Started | Skip if user setting `briefing_email=false` |

---

### Earnings — `/menu/earnings`

#### Done

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-108 | Fix col-7→col-6 layout; add inline detail panel below calendar using selEarning state | Frontend | 0.5d | P0 | FE Eng 1 | S-08 | **Done** | screens/earnings.tsx. |

#### Live Earnings — Calendar

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-025a | Build tab selector: Today/Tomorrow/This Week/Next Week/Custom; persist last-used tab in localStorage | Frontend | 0.5d | P0 | FE Eng 2 | S-04 | Not Started | Custom tab shows date range picker |
| T-025b | Fetch from `GET /api/v1/earnings?date={tab}&session={bmo|amc|all}`; skeleton loader on first load; auto-refresh every 15 min | Frontend | 0.5d | P0 | FE Eng 2 | S-04 | Not Started | |

#### Live Earnings — Table

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-026a | Build earnings row: ticker logo + name, timing pill (BMO/AMC), EPS actual/est/surprise%, Rev actual/est/surprise%, guidance, reaction; highlight if sym in portfolio | Frontend | 0.5d | P0 | FE Eng 1 | S-04 | Not Started | |
| T-026b | Add tag pills: Beats EPS (surprise > 10%), Misses Rev, Raises Guide, Lowers Guide, Inline, Mixed, High Short Interest, Large Move, Options Active | Frontend | 0.5d | P0 | FE Eng 1 | S-04 | Not Started | Computed from earnings fields |
| T-026c | Column sort: EPS surprise%, Rev surprise%, reaction; default sort by report time | Frontend | 0.5d | P0 | FE Eng 1 | S-04 | Not Started | useState for sort column + direction |

#### Live Earnings — API

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-027a | `GET /api/v1/earnings`: query Firestore `earnings_events` by date + session; join latest AI summary if available; cursor pagination (page size 50) | Backend | 0.5d | P0 | Backend | S-04 | Not Started | |
| T-027b | Add portfolio flag to response: for each row, check if sym is in user's Firestore portfolios (authenticated requests only) | Backend | 0.5d | P0 | Backend | S-04 | Not Started | |

#### Live Earnings — Detail Drawer

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-028a | Drawer shell: right-side panel (70% desktop / full mobile), header with ticker + timing pill, tab bar (Summary / Transcript / Audio / News / Peers) | Frontend | 0.5d | P0 | FE Eng 2 | S-05 | Not Started | Reuse `.stock-side-drawer` CSS class |
| T-028b | Summary tab: EPS/Rev headline metrics (beat/miss badge), guidance summary, 8-quarter history chart, AI summary card | Frontend | 0.5d | P0 | FE Eng 2 | S-05 | Not Started | |
| T-028c | News tab: last 24h news for ticker from Firestore `news` where sym matches; real-time prepend via WebSocket | Frontend | 0.5d | P0 | FE Eng 2 | S-05 | Not Started | |
| T-028d | Peers tab: peer reactions table (ticker, day%, next ER, analyst consensus); flag portfolio syms | Frontend | 0.5d | P0 | FE Eng 2 | S-05 | Not Started | |

#### Live Earnings — EPS Charts

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-029a | EPS history bar chart (Recharts): actual vs estimate bars; green=beat, red=miss; line overlay for estimate trend | Frontend | 0.5d | P0 | FE Eng 1 | S-05 | Not Started | |
| T-029b | Revenue history chart below EPS: same bar structure; guidance annotation per quarter (▲/▼/→) | Frontend | 0.5d | P0 | FE Eng 1 | S-05 | Not Started | |

#### Live Earnings — Backend AI

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-030a | `GET /api/v1/earnings/:ticker/detail`: full record from Firestore with peer reactions, guidance summary, transcript URL, 8-quarter history | Backend | 0.5d | P0 | Backend | S-05 | Not Started | |
| T-031a | Earnings AI worker: subscribe to BullMQ `earnings_summary` queue; fetch transcript from FMP `/api/v4/earning_call_transcript`; retry with backoff (transcript may lag 30-60 min) | Backend | 0.5d | P0 | Backend | S-05 | Not Started | |
| T-031b | Claude prompt for summary: inject transcript + metrics; structured JSON output `{beat_miss,guidance,tone,risks,takeaway,confidence}`; store in Firestore `earnings_summaries/{sym}_{date}` | Backend | 0.5d | P0 | Backend | S-05 | Not Started | Max 4000 token output |

#### Live Earnings — AI Card UI

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-032a | AI Earnings Summary card: tone badge (Bullish/Cautious/Neutral/Mixed), confidence label, key takeaway, expandable risks; poll for note every 30s if null | Frontend | 0.5d | P0 | FE Eng 1 | S-06 | Not Started | |

#### Live Earnings — Setup Card

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-058a | Implied move: fetch options chain via Unusual Whales; compute ATM straddle as % of stock price; show "±X%" vs historical avg | Frontend | 0.5d | P0 | FE Eng 1 | S-05 | Not Started | |
| T-058b | Last 4 reactions mini chart: 4 quarters of actual post-earnings day moves from API history field | Frontend | 0.5d | P0 | FE Eng 1 | S-05 | Not Started | |
| T-058c | Analyst sentiment trend: count upgrades vs downgrades last 30 days from Firestore `analyst_actions`; render as mini bar | Frontend | 0.5d | P0 | FE Eng 1 | S-05 | Not Started | |

#### Live Earnings — Movers Board

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-059a | Earnings Movers Board: table of largest post-earnings moves today (ticker, reaction%, beat/miss, guidance, sector, portfolio flag); sorted by absolute % | Frontend | 0.5d | P0 | FE Eng 2 | S-06 | Not Started | |
| T-059b | Real-time updates: subscribe to WebSocket `earnings:result`; prepend new movers; show "NEW" badge for 30s | Frontend | 0.5d | P0 | FE Eng 2 | S-06 | Not Started | |

---

### Market Movers — `/menu/movers`

#### Done

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-091 | Build Movers screen: view tabs, mover rows with RVOL + catalyst pill (static) | Frontend | 1d | P0 | FE Eng 2 | S-06 | **Done** | screens/movers.tsx. |
| T-122 | Replace modal/hover popup with stock-side-drawer embedding StockScreen | Frontend | 0.5d | P0 | FE Eng 1 | S-10 | **Done** | screens/movers.tsx. Dynamic import to avoid circular dependency. |

#### Live Movers

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-033a | Connect to `GET /api/v1/movers?tab={gainers|losers|volume|gapup|gapdown|highrvol|largecap}`; auto-refresh every 60s; show last-updated timestamp | Frontend | 0.5d | P0 | FE Eng 2 | S-06 | Not Started | |
| T-033b | Mover filter bar: index (S&P500/Nasdaq/All), sector, cap (Large/Mid/Small), price range, session (Regular/Pre/AH) | Frontend | 0.5d | P0 | FE Eng 2 | S-06 | Not Started | Pass filters as query params |
| T-034a | Mover row: ticker logo + name, price + %change + $change, RVol ratio bar, catalyst pill (color by type), MA context chip (Above/Below 20d MA) | Frontend | 0.5d | P0 | FE Eng 1 | S-06 | Not Started | |
| T-034b | Watchlist/portfolio badge on row: ★ if in watchlist, pf-icon if in portfolio (from Redux state) | Frontend | 0.5d | P0 | FE Eng 1 | S-06 | Not Started | |
| T-035a | Movers calculation job: every 60s market hours; query ClickHouse for top 50 by pct_change per tab; cache in Redis `movers:{tab}` TTL 60s | Backend | 0.5d | P0 | Backend | S-06 | Not Started | |
| T-035b | RVol computation: for each mover, divide today's volume (Redis quote cache) by 30d avg volume (ClickHouse daily_ohlcv) | Backend | 0.5d | P0 | Backend | S-06 | Not Started | High RVol tab threshold: RVol > 2.0 |
| T-062a | Weekly Movers backend: Friday 4:45pm ET cron; query ClickHouse for top 10 weekly gainers + losers; store in Firestore `weekly_movers/{date}` | Backend | 0.5d | P1 | Backend | S-06 | Not Started | |
| T-062b | Weekly Movers UI tab: show cached Firestore data; "Week of {date}" label; no auto-refresh | Frontend | 0.5d | P1 | FE Eng 1 | S-06 | Not Started | |

---

### Market Heatmap — `/menu/heatmap`

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-099 | Fix heatmap treemap tile text color using heatCol().fg | Frontend | 0.5d | P1 | FE Eng 1 | S-06 | **Done** | screens/heatmap.tsx. |

---

### Analyst Actions — `/menu/analyst`

#### Done

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-090 | Build Analyst Actions screen (static): direction arrows, firm, rating/PT change, action pills | Frontend | 1d | P0 | FE Eng 2 | S-07 | **Done** | screens/analyst.tsx. |
| T-109 | Add computeFlags() (5+ action alert) + topUpgrades sidebar | Frontend | 0.5d | P1 | FE Eng 1 | S-08 | **Done** | screens/analyst.tsx + data.ts. |
| T-142a | Move ◆ AI take · CRM cluster section to full-width position between signal cards (🔥 Cluster alert / My names PT) and the filter bar | Frontend | 0.25d | P1 | FE Eng 1 | S-12 | **Done** | screens/analyst.tsx. Added `<div className="ai-block">` wrapper at col-12 level. |
| T-142b | Remove col-8/col-4 dashboard split from rating table; make it full-width single card (remove `<div className="dash">` wrapper) | Frontend | 0.25d | P1 | FE Eng 1 | S-12 | **Done** | screens/analyst.tsx. Table and tbl-wrap now direct children of page content area. |

#### Live Analyst

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-036a | Connect to `GET /api/v1/analyst?type=all`; prepend new rows via WebSocket `feed:analyst_actions`; skeleton on initial load | Frontend | 0.5d | P0 | FE Eng 2 | S-07 | Not Started | |
| T-036b | Type filter bar: All / Upgrades / Downgrades / Initiations / PT Changes; Major Banks toggle (Goldman, MS, JPM, BofA, Citi, Wells, Barclays) | Frontend | 0.5d | P0 | FE Eng 2 | S-07 | Not Started | |
| T-036c | "My names" toggle: filter client-side to show only analyst actions for syms in Redux portfolio + watchlist | Frontend | 0.5d | P0 | FE Eng 2 | S-07 | Not Started | |
| T-037a | BullMQ AI note job: on new action in Firestore, call Claude with firm+rating change+stock sector; 1-sentence output | Backend | 0.5d | P1 | Backend | S-07 | Not Started | |
| T-037b | Store AI note in `analyst_actions/{id}.aiNote`; publish updated doc to Redis for WS fan-out; UI polls every 10s if note is null | Backend | 0.5d | P1 | Backend | S-07 | Not Started | |

---

### Screener — `/menu/screener`

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-083 | Build Stock Screener: 9 checkbox filters, 20 presets, RS-colored results table | Frontend | 3d | P0 | FE Eng 2 | S-05 | **Done** | screener.tsx. |
| T-137a | Rewrite screener layout to StockPanelLayout: 340px filter+results list card (left) + ChartCard (right) + StockScreenEmbed below | Frontend | 0.5d | P0 | FE Eng 1 | S-12 | **Done** | screens/screener.tsx. Matches portfolio/watchlist layout pattern. |
| T-137b | Wire all 9 checkbox filters live to screenerStocks array with no submit button; `applyPreset(idx)` maps preset.f fields to individual checkbox state | Frontend | 0.5d | P0 | FE Eng 1 | S-12 | **Done** | screens/screener.tsx. `selPx` resolved from watchData or moversData. |
| T-137c | Auto-fallback stock selection: `selStock = filtered.find(s => s.s === scrSel) ?? filtered[0] ?? null` so chart always shows a stock from current filter set | Frontend | 0.25d | P1 | FE Eng 1 | S-12 | **Done** | screens/screener.tsx. |

---

### IPOs — `/menu/ipos`

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-100 | Build IPOs screen: stats strip, recent performance table, upcoming pipeline tab | Frontend | 1d | P0 | FE Eng 1 | S-05 | **Done** | screens/ipos.tsx. |

---

### Stock Detail — `/menu/stock`

#### Done

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-094 | Build CandleChart + RsiPane SVG components (seeded RNG, MA overlays, hover tooltip) | Frontend | 2d | P0 | FE Eng 1 | S-08 | **Done** | utils.tsx. |
| T-095 | Build TrGauge + SemiGauge SVG components; RATING_VAL map | Frontend | 1d | P0 | FE Eng 1 | S-08 | **Done** | utils.tsx. |
| T-096 | Build Stock Detail screen (static, full HTML-parity) | Frontend | 3d | P0 | FE Eng 1 | S-08 | **Done** | screens/stock.tsx. StockInfo interface: `{name,px,c,mkt,pe,eps,wkh52,wkl52,div,beta,sec,ai_call,ai_thesis,ai_risk,ai_metrics,fin,news,ins}` |
| T-112 | Firebase stock notes: right-click chart → save/load/delete Firestore `stock_comments` | Frontend | 1.5d | P0 | FE Eng 1 | S-08 | **Done** | screens/stock.tsx. |
| T-124 | Remove Ask Copilot button from sd-actions row | Frontend | 0.5d | P1 | FE Eng 1 | S-10 | **Done** | screens/stock.tsx. |

#### Live Stock — Chart

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-042a | Replace seeded CandleChart with real OHLCV: `GET /api/v1/ohlcv?sym=&tf={1d|1w|1m|3m|6m|1y|3y}`; keep seeded as fallback | Frontend | 0.5d | P0 | FE Eng 1 | S-08 | Not Started | |
| T-042b | Overlay earnings events on chart: vertical dashed line at each ER date; show surprise% tooltip on hover | Frontend | 0.5d | P0 | FE Eng 1 | S-08 | Not Started | ER dates from `GET /api/v1/earnings?sym=&limit=8` |
| T-042c | Overlay analyst actions: tiny badge at action date; show firm + direction on hover | Frontend | 0.5d | P0 | FE Eng 1 | S-08 | Not Started | Data from Firestore `analyst_actions where sym=ticker` |
| T-042d | 1D intraday view: use real-time tick aggregation from Redis; 1W–3Y use daily OHLCV from ClickHouse | Frontend | 0.5d | P0 | FE Eng 1 | S-08 | Not Started | Superseded by T-144a (Firestore, not Redis/ClickHouse) |

#### Live Stock — Real Chart Data (2026-07-22)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-144a | `app/iq/hooks/useChartBars.ts`: serve **all 7 timeframes** (1D/1W/1M/3M/6M/1Y/5Y) from real bars — `intraday_bars` for 1D/1W, `ohlcv_bars` for 1M–5Y | Frontend | 1d | P0 | FE Eng 1 | S-13 | **Done** | ✅ **No synthetic chart timeframes remain.** The prior assessment recorded 1D/1W/5Y as blocked by the data plan — that diagnosis was **wrong**. Both intraday aggregates and 5-year history were authorized all along (T-143L); it was a **sync gap, not a plan gap**. Closed by T-143a + T-143c. |
| T-144b | Hooks `useCompany`, `useDividendHistory`, `useSplits` | Frontend | 0.5d | P1 | FE Eng 1 | S-13 | **Done** | `app/iq/hooks/`. Back the peers list, dividend history/streak/CAGR panel and split history on Stock Detail. |
| T-144c | Hook `useExtendedHours` (pre-market / after-hours move) | Frontend | 0.5d | P1 | FE Eng 1 | S-13 | **In Review** | ⚠ BUILT, NOT LIVE — depends on the backend snapshot endpoint (T-143h), which the browser cannot reach (T-148b). Renders nothing in production. |

#### Live Stock — Peer View

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-043a | Peer table: 5 closest peers (same industry group), columns: ticker, 1D/1W/1M perf, mkt cap, next ER date, analyst consensus | Frontend | 0.5d | P1 | FE Eng 2 | S-09 | Not Started | `GET /api/v1/stocks/{sym}/peers` |
| T-043b | Leader badge: peer with highest 1-month RS gets "Leader"; current sym gets "You" badge | Frontend | 0.5d | P1 | FE Eng 2 | S-09 | Not Started | RS = 1-month return vs S&P 500 |

#### Live Stock — Group View

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-044a | Group header: industry group name, rank among all groups (1–197), trend arrow (rising/falling/flat) | Frontend | 0.5d | P1 | FE Eng 1 | S-09 | Not Started | `GET /api/v1/groups/{groupId}` |
| T-044b | Top 3 + bottom 3 names in group by 1-month RS; click to open Stock Detail for that sym | Frontend | 0.5d | P1 | FE Eng 1 | S-09 | Not Started | |

#### Live Stock — AI Technical Analysis (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-057a | API endpoint: accept sym + OHLCV 90d + indicator values (RSI, MACD, Bollinger); call Claude async via BullMQ; client polls | Backend | 0.5d | P0 | Backend | S-13 | Not Started | Phase 2 |
| T-057b | Build 4-tone Claude prompts: Summary / Swing Trader / Position Trader / LT Investor; store all 4 in `ta_analysis/{sym}` | Backend | 0.5d | P0 | Backend | S-13 | Not Started | Phase 2 |

---

### Options Chain — `/menu/options`

#### Done

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-131 | Build Options Chain screen: left stock search sidebar (movers + EXTRA_STOCKS merged, alphabetical), expiry tabs (5 expirations), calls+puts chain table (OI/Vol/IV/Last/Bid/Ask × Strike), ATM row highlight, seeded deterministic `buildChain()` | Frontend | 1.5d | P0 | FE Eng 1 | S-11 | **Done** | screens/options.tsx. OptionRow interface: `{k, atm, call:{last,bid,ask,iv,vol,oi,itm}, put:{...}}` |

#### Live Options Chain

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-132a | Fetch expiry dates from `GET /api/v1/options/expirations?sym=`; replace hardcoded `EXPS` array; update on sym change | Frontend | 0.5d | P0 | FE Eng 1 | S-11 | Not Started | Backend source: Tradier `GET /v1/markets/options/expirations` |
| T-132b | Fetch live chain from `GET /api/v1/options/chain?sym=&expiry=`; normalize to OptionRow interface; refresh every 30s during market hours | Frontend | 0.5d | P0 | FE Eng 1 | S-11 | Not Started | Backend: Tradier chain API → normalize `{strike, call:{last,bid,ask,iv,volume,open_interest}, put:{...}}` → cache Redis `options:{sym}:{expiry}` TTL 60s |
| T-132c | Highlight top-5 OI strikes per side (calls / puts); show implied move calculation (ATM straddle ÷ stock price) in header meta | Frontend | 0.5d | P1 | FE Eng 1 | S-12 | Not Started | |
| T-132d | API endpoint: `GET /api/v1/options/chain?sym=&expiry=`; proxy to Tradier; normalize schema; cache in Redis TTL 60s; 401 if tier < pro | Backend | 0.5d | P0 | Backend | S-11 | Not Started | Tradier free with brokerage account |

---

### Insider & Institutional — `/menu/insider`

#### Done

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-087 | Build 13F Intelligence screen: fund cards, AI summary blocks, cross-ownership tables (static) | Frontend | 2d | P0 | FE Eng 1 | S-12 | **Done** | screens/insider.tsx (13F tab). Fund interface: `{nm,av,mgr,aum,pos,top,newPos,exits,q}` |
| T-101 | Build Insider & Institutional screen: tabbed Insider activity + 13F institutional | Frontend | 2d | P0 | FE Eng 1 | S-07 | **Done** | screens/insider.tsx. |

#### Live 13F Data (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-052a | EDGAR full-text index poller: detect new 13F-HR filings nightly; compare to cached last-seen filing date per CIK | Backend | 0.5d | P0 | Backend | S-12 | Not Started | Phase 2 |
| T-052b | 13F XML parser: extract fund name, report date, all holdings (CUSIP, value, shares); handle both 13F-HR and 13F-HR/A amended schemas | Backend | 1d | P0 | Backend | S-12 | Not Started | Phase 2; most complex parsing step |
| T-052c | Load to Firestore `fund_holdings/{CIK}/{quarter}/{CUSIP}`; compute delta vs prior quarter (new/added/trimmed/exited/unchanged) | Backend | 0.5d | P0 | Backend | S-12 | Not Started | Phase 2 |
| T-053a | 13F AI summary BullMQ job: call Claude with fund name + top 25 holdings + delta; output 3 key themes | Backend | 0.5d | P0 | Backend | S-12 | Not Started | Phase 2 |
| T-053b | Store summary in Firestore `fund_summaries/{CIK}/{quarter}`; publish to in-app feed | Backend | 0.5d | P0 | Backend | S-12 | Not Started | Phase 2 |

#### Cross-Fund Views (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-066a | "Most Owned" view: aggregate fund_holdings to find top 20 CUSIPs by fund count; ranked list | Frontend | 0.5d | P0 | FE Eng 1 | S-12 | Not Started | Phase 2 |
| T-066b | Co-Attribution Screener: user selects 2–5 funds; show positions held by ALL selected funds (intersection query) | Frontend | 1d | P0 | FE Eng 1 | S-12 | Not Started | Phase 2 |

#### Options Flow & Block Trades (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-067a | Options Flow board UI: table rows (ticker, call/put, strike, expiry, premium, total value, vol/OI ratio) | Frontend | 0.5d | P0 | FE Eng 2 | S-11 | Not Started | Phase 2 |
| T-067b | Options filters: All/Calls/Puts/Sweeps; min premium dropdown ($50k/$100k/$250k/$500k) | Frontend | 0.5d | P0 | FE Eng 2 | S-11 | Not Started | Phase 2 |
| T-068a | Block Trades board UI: rows (ticker, value, shares, price, vs-VWAP badge, time, direction arrow); sector + size filters | Frontend | 0.5d | P1 | FE Eng 1 | S-11 | Not Started | Phase 2 |

---

### Themes — `/menu/themes`

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-136 | See Shell & Design section | — | — | — | — | — | — | Themes screen refactored to use StockPanelLayout (documented under T-136 in Shell & Design). |

---

### Commentary — `/menu/commentary`

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-088 | Build Commentary screen: 5 tabs, feed cards, sidebar cards | Frontend | 1.5d | P0 | FE Eng 2 | S-03 | **Done** | screens/commentary.tsx. |
| T-116 | Tab filtering: Premarket, AH, My names, Macro; FeedItem component | Frontend | 0.5d | P1 | FE Eng 1 | S-09 | **Done** | screens/commentary.tsx. |
| T-119 | Add ticker search bar (SEARCH_SYMS autocomplete) + NewsDrawer with buildNewsHistory() (9 categories) | Frontend | 1d | P1 | FE Eng 1 | S-10 | **Done** | screens/commentary.tsx. |
| T-140a | Remove standalone Quick news lookup card from col-4 sidebar | Frontend | 0.25d | P1 | FE Eng 1 | S-12 | **Done** | screens/commentary.tsx. Card was duplicating content now handled at bottom of feed column. |
| T-140b | Add permanent Quick news lookup card at bottom of col-8 feed column (below feed card); use `activeTab === 3 ? "Tracked names" : "Quick news lookup"` for context-aware title and chip list | Frontend | 0.5d | P1 | FE Eng 1 | S-12 | **Done** | screens/commentary.tsx. My names tab shows `[...mySymbols]` chips; all others show 8 hardcoded ticker chips. |
| T-141 | General perspective card in col-4: add `style={{ flex: 1 }}` so its bottom border aligns with the Quick news lookup card bottom | Frontend | 0.25d | P1 | FE Eng 1 | S-12 | **Done** | screens/commentary.tsx. |

---

## My Money

### Portfolio Pulse — `/menu/portfolio`

#### Done

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-085 | Build Portfolio screen: AI pulse block + holdings table (static) | Frontend | 1.5d | P0 | FE Eng 1 | S-07 | **Done** | screens/portfolio.tsx. FolioItem interface. |
| T-110 | Extend Portfolio with useState CRUD + dynamic drivers/laggards/leaders | Frontend | 1d | P0 | FE Eng 1 | S-08 | **Done** | screens/portfolio.tsx. |
| T-118 | Add AI Pulse card (PULSE string array as bullets) | Frontend | 0.5d | P1 | FE Eng 1 | S-09 | **Done** | screens/portfolio.tsx. |
| T-120 | Replace inline StockDetail with embedded StockScreen in right panel | Frontend | 0.5d | P0 | FE Eng 1 | S-10 | **Done** | screens/portfolio.tsx. Dynamic import; pfSel state. |
| T-135a | Refactor portfolio.tsx to import StockPanelLayout, StockListCard, StockRow from stock-panel.tsx; remove local dynamic import and local StockScreenEmbed definition | Frontend | 0.5d | P1 | FE Eng 1 | S-12 | **Done** | screens/portfolio.tsx. |
| T-135b | Remove dead `convPill` function from portfolio.tsx (leftover from old layout, was never called) | Frontend | 0.25d | P2 | FE Eng 1 | S-12 | **Done** | screens/portfolio.tsx. Cleanup only; zero UI change. |

#### Persistent Portfolio

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-038a | Persist holdings to Firestore `users/{uid}/portfolios/{id}`: addDoc on add; updateDoc on partial sell; deleteDoc on remove | Frontend | 0.5d | P0 | FE Eng 1 | S-07 | Not Started | Load from Firestore on mount; replace mock seed data |
| T-038b | Fetch live prices for all holdings on mount: `GET /api/v1/quotes?syms={csv}`; refresh every 30s market hours | Frontend | 0.5d | P0 | FE Eng 1 | S-07 | Not Started | |
| T-038c | Subscribe to WebSocket `feed:portfolio:{uid}` for real-time price updates; update holdings state on quote message | Frontend | 0.5d | P0 | FE Eng 1 | S-07 | Not Started | |

#### Portfolio AI Briefing

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-039a | BullMQ daily job (7am ET): for each holding in user's Firestore portfolio, fetch last-24h news + analyst actions from Firestore | Backend | 0.5d | P0 | Backend | S-07 | Not Started | |
| T-039b | Call Claude with per-holding events; generate `[{sym, note}]` array (1 sentence per sym with material event); store in Firestore `portfolio_pulse/{uid}/{date}` | Backend | 0.5d | P0 | Backend | S-07 | Not Started | Skip holdings with no events |

#### Broker Import (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-073a | SnapTrade OAuth: `POST /api/v1/portfolio/connect` generates OAuth URL; callback stores access token in Firestore `users/{uid}/brokerage_tokens` | Backend | 1d | P1 | Backend | S-16 | Not Started | Phase 2 |
| T-073b | Brokerage sync job: pull positions from SnapTrade `/holdings`; compare to Firestore portfolio; surface discrepancies for user confirmation | Backend | 0.5d | P1 | Backend | S-16 | Not Started | Phase 2 |
| T-073c | Reconciliation UI: modal showing brokerage positions vs manual entries; accept/reject per change; write accepted changes to Firestore | Frontend | 0.5d | P1 | FE Eng 1 | S-16 | Not Started | Phase 2 |

---

### Watchlist — `/menu/watchlist`

#### Done

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-086 | Build Watchlist screen: 2-panel table with ER/analyst/options/headline columns (static) | Frontend | 1.5d | P0 | FE Eng 2 | S-07 | **Done** | screens/watchlist.tsx. |
| T-111 | Add AI alerts column + per-stock AI toggle | Frontend | 0.5d | P1 | FE Eng 1 | S-08 | **Done** | screens/watchlist.tsx. |
| T-115 | Rewrite as Google Finance 2-panel layout with bigChartSVG() | Frontend | 1.5d | P1 | FE Eng 1 | S-09 | **Done** | screens/watchlist.tsx + app/iq.css. |
| T-121 | Add stock-side-drawer + delete confirmation modal + localStorage("iq-watchlist") persistence | Frontend | 1d | P0 | FE Eng 1 | S-10 | **Done** | screens/watchlist.tsx. |
| T-134 | Refactor watchlist.tsx to import StockPanelLayout, StockListCard, StockRow from stock-panel.tsx; remove local StockScreenEmbed, CandleChart, Spark imports | Frontend | 0.5d | P1 | FE Eng 1 | S-12 | **Done** | screens/watchlist.tsx. StockRow valueBottom shows `${arr(c)} ${sign(c)}`. |

#### Persistent Watchlist

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-063a | Migrate from localStorage to Firestore `users/{uid}/watchlists/default`; load on mount; write on add/remove; keep localStorage as optimistic cache | Frontend | 0.5d | P0 | FE Eng 2 | S-07 | Not Started | |
| T-063b | Enforce 5-symbol Free limit: on add, check Redux tier; show upgrade CTA if Free + count >= 5 | Frontend | 0.5d | P0 | FE Eng 2 | S-07 | Not Started | |

#### Alert Rules

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-040a | Alert rule builder modal: event type selector (12 types), threshold input, delivery channel toggles (in-app, email) | Frontend | 0.5d | P0 | FE Eng 2 | S-08 | Not Started | Opens from bell icon per watchlist row |
| T-040b | Save rule to Firestore `users/{uid}/alerts/{id}`: `{sym,type,threshold,channels,enabled:true,createdAt}` | Frontend | 0.5d | P0 | FE Eng 2 | S-08 | Not Started | Validate threshold > 0 |

#### Alert Engine

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-041a | Alert event processor: subscribe to Redis pub/sub (feed:all, quotes:*, earnings:result); load enabled alerts for matching syms from Firestore (cache rules in Redis TTL 5min) | Backend | 0.5d | P0 | Backend | S-08 | Not Started | |
| T-041b | Rule evaluator: on match (price > threshold, vol > 3x, analyst upgrade, etc.), create Firestore `users/{uid}/notifications/{id}` + enqueue SendGrid email via BullMQ | Backend | 0.5d | P0 | Backend | S-08 | Not Started | |

---

---

## Context

### Recaps — `/menu/recap`

#### Done

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-089 | Build Recap screen: recap-hero, sector heatmap, movers + internals (static) | Frontend | 1.5d | P0 | FE Eng 1 | S-10 | **Done** | screens/recap.tsx. |
| T-117 | Add "This Week" tab with WEEKLY static data | Frontend | 0.5d | P1 | FE Eng 1 | S-09 | **Done** | screens/recap.tsx. |
| T-118 | Add AI Pulse card to Portfolio screen (PULSE array as bullets) | Frontend | 0.5d | P1 | FE Eng 1 | S-09 | **Done** | screens/portfolio.tsx. |

#### Live Recaps — EOD

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-049a | EOD data collector: cron `30 16 * * 1-5` ET; fetch final index prices from Redis + top stories from Firestore (last 24h ranked by importance) + top movers + earnings results | Backend | 0.5d | P0 | Backend | S-10 | Not Started | |
| T-049b | Call Claude with EOD data; structured output `{headline,summary,topStories[],sectorPerformance[],earningsMovers[]}`; store in Firestore `recaps/{date}` | Backend | 0.5d | P0 | Backend | S-10 | Not Started | |
| T-049c | Trigger SendGrid email dispatch after recap stored; send to users with `recap_email=true` in settings | Backend | 0.5d | P0 | Backend | S-10 | Not Started | |

#### Live Recaps — Frontend

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-050a | Connect Recap screen to API: `GET /api/v1/recaps/latest` (EOD) + `GET /api/v1/recaps/weekly`; fallback to last stored if today's not yet generated | Frontend | 0.5d | P0 | FE Eng 1 | S-10 | Not Started | |
| T-050b | Article/bullets view toggle: article = full prose; bullets = condensed per section; persist preference in localStorage | Frontend | 0.5d | P0 | FE Eng 1 | S-10 | Not Started | |

#### Live Recaps — Weekly

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-051a | Weekly recap data collector: cron Friday 6pm ET; fetch 5-day performance + top weekly stories + sector leaders/laggards | Backend | 0.5d | P0 | Backend | S-10 | Not Started | |
| T-051b | Call Claude for weekly summary; store in Firestore `recaps/weekly/{week_end_date}` | Backend | 0.5d | P0 | Backend | S-10 | Not Started | |

#### Audio TTS (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-071a | TTS pipeline: after EOD recap stored, enqueue `audio_recap` job; Claude generates 60s spoken-word script (~150 words) | Backend | 0.5d | P1 | Backend | S-14 | Not Started | Phase 2 |
| T-071b | Convert script to MP3 via ElevenLabs or AWS Polly; upload to S3 `recaps/{date}.mp3`; store URL in Firestore recap record | Backend | 0.5d | P1 | Backend | S-14 | Not Started | Phase 2 |

#### Social Sharing (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-075a | Recap card image: server-side Canvas/Puppeteer renders branded card (date, headline, index bar chart, top mover) | Frontend | 0.5d | P2 | FE Eng 2 | S-17 | Not Started | Phase 2 |
| T-075b | Share buttons: Twitter Web Intent URL + LinkedIn Share API; trigger card image download | Frontend | 0.5d | P2 | FE Eng 2 | S-17 | Not Started | Phase 2 |

---

### Macro & VIX — `/menu/macro`

#### Done

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-092 | Build Macro screen: calendar table, market regime widget, VIX section (static) | Frontend | 1d | P1 | FE Eng 1 | S-09 | **Done** | screens/macro.tsx. |
| T-113 | Expand to 3-week calendar: MacroEvent interface, CAL_LAST/THIS/NEXT arrays, 8-column table | Frontend | 0.5d | P1 | FE Eng 1 | S-08 | **Done** | screens/macro.tsx. |

#### Live Macro

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-045a | VIX widget: fetch from Redis `q:VIX`; compute 12-month percentile from ClickHouse VIX history; 30-day sparkline | Frontend | 0.5d | P1 | FE Eng 2 | S-09 | Not Started | Update every 5 min |
| T-045b | VIX trend label: "Rising Fast" / "Elevated & Falling" / "Subdued" / "Spiking" based on 5-day delta + absolute level | Frontend | 0.5d | P1 | FE Eng 2 | S-09 | Not Started | Plain-English explanation below label |
| T-046a | Connect Macro Calendar to Firestore `macro_events` (from T-016b): replace CAL_* static arrays | Frontend | 0.5d | P1 | FE Eng 1 | S-09 | Not Started | `GET /api/v1/macro?week={last|this|next}` |
| T-046b | Highlight actuals: if event.actual is set, color surprise cell green (actual > est) or red; bold actual value; compute surprise% | Frontend | 0.5d | P1 | FE Eng 1 | S-09 | Not Started | surprise% = (actual − est) / |est| × 100 |

---

---

## Platform & Shell

### Shell & Design System

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-077 | Build IQShell: sidebar nav, topbar, drawer system, AI Copilot panel, Cmd+K, profile dropdown | Frontend | 5d | P0 | FE Eng 1 | S-03 | **Done** | shell.tsx. IQActionsContext. 14 screens. |
| T-078 | Build MarketCatalyst design system (iq.css): CSS custom properties, dark/light themes, layout primitives | Frontend | 3d | P0 | FE Eng 1 | S-03 | **Done** | Imported globally in app/layout.tsx. |
| T-082 | Wire dark mode to Firestore settings/{uid}; localStorage fast cache; ThemeConfirmModal | Frontend | 1d | P0 | FE Eng 1 | S-03 | **Done** | settings.tsx + shell.tsx + firestore.rules. |
| T-114 | Extend Cmd+K: SEARCHABLE_STOCKS constant + starred stocks (Set state + toggleStar) | Frontend | 0.5d | P1 | FE Eng 1 | S-08 | **Done** | shell.tsx. |
| T-123 | Code cleanup: remove dead code, centralise hashStr/EarnQ/earnHistory in utils.tsx | Cleanup | 1d | P1 | FE Eng 1 | S-10 | **Done** | Zero TS errors. No UI changes. |
| T-125 | Mobile responsive shell: hamburger (`.mob-ham`), slide-in rail (`.rail.mob-open`), scrim inside `.app` (stacking context fix — scrim z-100, rail z-200), `navOpen` state + Escape/pathname close, mobile-brand in topbar | Frontend | 1.5d | P0 | FE Eng 1 | S-11 | **Done** | `app/iq/shell.tsx` + `app/iq.css`. `@media (max-width: 767px)` breakpoint. |
| T-126 | Auth pages mobile responsive: added `lp-auth-cols` / `lp-auth-left` / `lp-auth-form` classes to wire `@media` rules (class was missing — two-column layout never collapsed). `≤900px` stacks vertically; `≤600px` hides marketing panel, form full-width | Frontend | 0.5d | P0 | FE Eng 1 | S-11 | **Done** | `app/auth/auth-layout.tsx`. |
| T-127 | Firebase Auth iOS Safari fix: `initializeAuth` with `[indexedDBLocalPersistence, browserLocalPersistence]` (ITP-safe). All Google handlers: `signInWithPopup` first → `signInWithRedirect` fallback. `getRedirectResult` on mount in LoginForm + SignupForm | Frontend | 1d | P0 | FE Eng 1 | S-11 | **Done** | `app/firebase.ts` + `app/auth/login/login-form.tsx` + `app/auth/signup/signup-form.tsx` + `app/page.tsx`. |
| T-128 | Profile dropdown: `iq-dropdownIn` animation (no `translateX` — fixes post-animation position jump). `pd-avatar` 52px image centered at top of dropdown. `animation-fill-mode: both` | Frontend | 0.5d | P1 | FE Eng 1 | S-11 | **Done** | `app/iq.css` + `app/iq/shell.tsx`. |
| T-129 | Landing page fixes: WebGL canvas visible (`background: transparent` on `.lp-root.mq-root`). `ScaledScreen` uses `ResizeObserver` for dynamic scale (`containerWidth/1200`) — fixes glance modal at any width | Frontend | 0.5d | P1 | FE Eng 1 | S-11 | **Done** | `app/landing.css` + `app/page.tsx`. |
| T-130 | Mobile options page: expiry tabs horizontal scroll (`flex-wrap:nowrap; overflow-x:auto`), stock header meta wraps below price. Nav items `var(--text-hi)` in mobile rail. AI badge removed from Earnings nav item (`badge: null`) | Frontend | 0.5d | P1 | FE Eng 1 | S-11 | **Done** | `app/iq.css` + `app/dashboard/menu-items.ts`. |
| T-133a | Create `app/iq/stock-panel.tsx`: define `StockScreenEmbed` via `dynamic()` (single shared definition eliminates circular import duplication across 4 screens) | Frontend | 0.5d | P1 | FE Eng 1 | S-12 | **Done** | `app/iq/stock-panel.tsx`. Note: shell.tsx keeps its own local copy to avoid its own circular chain. |
| T-133b | Add `StockRow` component to stock-panel.tsx: `pf-li` grid row with sym/name/Spark/valueTop/valueBottom/optional trash button; `gridTemplateColumns` switches between "1fr 60px auto auto" (with delete) and "1fr 60px auto" (without) | Frontend | 0.5d | P1 | FE Eng 1 | S-12 | **Done** | `app/iq/stock-panel.tsx`. TrashIcon SVG private to module. |
| T-133c | Add `StockListCard` component to stock-panel.tsx: 340px fixed-width flex column card with scrollable `pf-list`, optional `headerRight` slot, empty state support | Frontend | 0.25d | P1 | FE Eng 1 | S-12 | **Done** | `app/iq/stock-panel.tsx`. |
| T-133d | Add `ChartCard` component to stock-panel.tsx: right-side flex-1 card with TF toolbar (["1D","1W","1M","3M","6M","1Y","5Y"]) and CandleChart; empty state placeholder | Frontend | 0.25d | P1 | FE Eng 1 | S-12 | **Done** | `app/iq/stock-panel.tsx`. |
| T-133e | Add `StockPanelLayout` component to stock-panel.tsx: top flex row (listCard + ChartCard with alignItems:stretch) + StockScreenEmbed below; empty state for both chart and detail pane | Frontend | 0.25d | P1 | FE Eng 1 | S-12 | **Done** | `app/iq/stock-panel.tsx`. |
| T-136 | Refactor themes.tsx to use StockPanelLayout, StockListCard, StockRow from stock-panel.tsx; themes rows have no delete button (read-only list; `onDelete` omitted → 3-column grid) | Frontend | 0.5d | P1 | FE Eng 1 | S-12 | **Done** | screens/themes.tsx. THEMES array kept as module-level constant. `valueBottomClass={cls(stock.c)}`. |
| T-138a | Optimize utils.tsx: remove `_hash` wrapper function (was just `return hashStr(s)`); inline `hashStr(sym + tf)` calls directly in genOHLC and RsiPane | Frontend | 0.25d | P2 | FE Eng 1 | S-12 | **Done** | `app/iq/utils.tsx`. Dead wrapper function removed. |
| T-138b | Add `useMemo` to CandleChart: `const data = useMemo(() => genOHLC(sym, tf, px), [sym, tf, px])` — prevents full chart recomputation on every tooltip mouse-move hover rerender | Frontend | 0.25d | P1 | FE Eng 1 | S-12 | **Done** | `app/iq/utils.tsx`. Fixes performance regression on hover. |
| T-139a | Remove dead `CommandPalette` component from shell.tsx (~70 lines, was never rendered — superseded by inline topbar search) | Frontend | 0.25d | P2 | FE Eng 1 | S-12 | **Done** | `app/iq/shell.tsx`. |
| T-139b | Move `tickerItems` constant to module level (outside `IQShell` component body) to avoid recreating the array on every render | Frontend | 0.25d | P2 | FE Eng 1 | S-12 | **Done** | `app/iq/shell.tsx`. |

### Subscription & Billing

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-065a | Tier comparison page: Free/Pro/Premium feature matrix, price, billing toggle (monthly/annual), "Get started" CTA per tier | Frontend | 0.5d | P0 | FE Eng 2 | S-08 | Not Started | Route: /menu/manage-plan (already scaffolded). Plan data now exists (T-146a) — this is UI only. |
| T-065b | Stripe Checkout integration: `POST /api/v1/billing/create-checkout-session`; redirect to Stripe-hosted page; tier updated via webhook (T-010b) | Frontend | 0.5d | P0 | FE Eng 2 | S-08 | Not Started | ⛔ **NOT BUILT — no Stripe code exists in either repo.** Additionally blocked on T-148b: checkout *and* webhooks both require a browser-reachable backend. `payments` / `subscriptions` collections exist and are **empty**. |
| T-065c | Feature gate component: `<TierGate minTier="pro">`; if Free user hits gated feature, show upgrade modal inline | Frontend | 0.5d | P0 | FE Eng 2 | S-08 | Not Started | **Superseded by T-146f/T-146g** — shipped as `EntitlementGate` / `PlanGate` keyed on named entitlements rather than an ordinal tier. Retained here for traceability; do not build. |

#### Plans & Entitlements (2026-07-22) — additional scope, not in the weekly plan

> ⚠ This subsection is **outside** the 36-row weekly delivery plan
> (`MarketCatalyst.ai_weekly_deliverables_Plan.xlsx`). It is additional scope
> and is excluded from that plan's completion percentages.

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-146a | `src/plans/plans.registry.ts`: 30 entitlement keys, 3 plans, `formatAmount()` | Backend | 0.5d | P0 | Backend | S-13 | **Done** | Seeded and verified in prod Firestore (`plans`, 3 docs). Free 0 / Plus 2999 / Pro 4999 — **amounts are MINOR units (cents)**, so 4999 = $49.99. Cumulative ladder: Free 8/30 (marketCatalyst, news, scanner, heatmap, macro, ipos, chartsDaily, watchlist) → Plus +12 = 20/30 (chartsIntraday, chartsHistory, chartIndicators, chartNotes, technicalRatings, dividendHistory, peers, earningsDetail, portfolio, screener, themes, alerts) → Pro +8 = 28/30 (fundamentalRatings, ownership, optionsChain, exportData, apiAccess, aiAssistant, backtesting, paperTrading). **Pro is 28/30, not 30/30:** `adminDashboard` + `userManagement` are staff-only and false on every plan — selling them would be privilege escalation. |
| T-146b | `plans.service.ts`: seed/read `plans`, **merge-based** so operator edits survive re-seeding | Backend | 0.5d | P0 | Backend | S-13 | **Done** | A destructive seed would silently revert every per-plan feature toggle an operator made in the admin console (T-147c) on the next deploy. |
| T-146c | `subscriptions.service.ts`: resolve effective subscription | Backend | 0.5d | P0 | Backend | S-13 | **Done** | ⚠ **Expiry is computed at read time, never trusted from the stored doc** — nothing currently rewrites a user doc when a subscription lapses, so a stored `active` flag would go stale and grant free Pro access forever. Falls back to FREE, never to no-access. |
| T-146d | `plans.controller.ts`: `GET /plans`, `POST /plans/seed` (admin), `GET /users/:uid/entitlements` | Backend | 0.5d | P0 | Backend | S-13 | **In Review** | ⚠ BUILT, NOT LIVE — deployed on rev 00031-wvc but unreachable from the browser (T-148b). The frontend resolves entitlements directly from Firestore instead. |
| T-146e | `admin-analytics.service.ts` + `admin-analytics.controller.ts`: `GET /admin/users`, `GET /admin/subscriptions`, `GET /admin/revenue`, all admin-guarded | Backend | 1d | P1 | Backend | S-13 | **In Review** | ⚠ BUILT, NOT LIVE — same reachability gap (T-148b). **Staff accounts are excluded from every metric** so internal usage never inflates the numbers. |
| T-146f | `app/iq/entitlements.tsx`: `EntitlementProvider`, `useSubscription`, `useEntitlement`, `EntitlementGate`, `formatAmount` | Frontend | 1d | P0 | FE Eng 1 | S-13 | **Done** | Reads Firestore directly (see T-146d). |
| T-146g | `app/iq/entitlement-gate.tsx`: `PlanGate` upgrade panel, `useSlugEntitled` (hides nav items), `SLUG_ENTITLEMENT` map | Frontend | 0.5d | P0 | FE Eng 1 | S-13 | **Done** | |
| T-146h | Keep the **two gating layers separate**: `FF_*` release flags (T-006/feature-flags registry) vs plan entitlements | Architecture | 0.25d | P0 | Backend | S-13 | **Done** | ⚠ **Do not merge these.** `FF_*` answers *"is it built and shipped?"* → renders **"coming soon"**. Entitlements answer *"may this tier use it?"* → renders **"upgrade to unlock"**. A feature is usable only when BOTH are true. Merging them would make an unbuilt feature masquerade as a paywall — concretely, `backtesting` and `paperTrading` are granted on Pro but **not built**, and must show "coming soon", not an upsell. |

### Admin Console & Analytics (2026-07-22) — additional scope, not in the weekly plan

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-147a | `app/admin/admin-data.ts`: build the console dataset from Firestore and stage it in `sessionStorage` **before** the iframe mounts | Frontend | 0.5d | P0 | FE Eng 1 | S-13 | **Done** | Ordering matters — the iframe reads `sessionStorage` synchronously on load, so staging after mount yields an empty console. |
| T-147b | `public/admin/console.html`: render REAL data; suppress fabricated trend deltas and the fake MRR history chart whenever real data is present | Frontend | 1d | P0 | FE Eng 1 | S-13 | **Done** | The console shipped with demo scaffolding. Leaving invented deltas next to real numbers would make fiction indistinguishable from fact on an operator screen. |
| T-147c | Per-plan feature editor in the admin console (writes `plans/{id}.featureFlags`) | Frontend | 0.5d | P1 | FE Eng 1 | S-13 | **Done** | Constrained by the rule in T-145e to `featureFlags` + `updatedAt` only; price/currency/cycle stay server-only. |
| T-147d | **Monitor** nav item in the admin console, embedding the backend ops UI | Frontend | 0.25d | P1 | FE Eng 1 | S-13 | **In Review** | ⚠ BUILT, NOT LIVE — **dead in production.** Embeds the backend ops UI, which the browser cannot reach (T-148b). Works locally only. |
| T-147e | `app/iq/feature-adoption.ts` + `app/iq/track-feature.tsx`: track **48 features** (all `menuItems` screens + in-app actions — 8 stock drawers, chart timeframes/indicators/expand, watchlist add/remove, search, screener, news…) | Frontend | 1d | P1 | FE Eng 1 | S-13 | **Done** | 30-second dedupe; **failures are swallowed so analytics can never break a screen**. Only ~12 seeded rows so far — the signal is thin until real traffic arrives. This is the **only** client-writable analytics collection, forced by T-148b, and its rule is correspondingly tight (T-145e). |
| T-147f | `api_usage` recording middleware | Backend | 1d | P1 | Backend | S-14 | Not Started | ⛔ **NOT BUILT.** Collection and admin-read rule exist; nothing writes to them. The admin **"Usage & API" KPIs read 0** — they are unimplemented, not broken. Do not report them as a metric. |
| T-147g | Per-user engagement columns in the admin console (watchlists / holdings / apiCalls / alerts) | Backend | 1d | P2 | Backend | S-14 | Not Started | ⛔ **NOT BUILT.** All four render 0 — no collection backs them. `apiCalls` additionally depends on T-147f. |
| T-147h | Populate the remaining specified-but-empty collections: `payments`, `subscriptions`, `audit_logs`, `revenue_summary`, `system_metrics` | Backend | 2d | P1 | Backend | S-14 | Not Started | ⛔ **NOT BUILT.** Collections + rules exist; nothing writes to them. `payments`/`subscriptions` depend on Stripe (T-065b), which depends on T-148b. |

### AI Copilot (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-054a | Copilot panel UI: slide-in drawer from right, chat message list, input box, streaming token display | Frontend | 0.5d | P0 | FE Eng 1 | S-14 | Not Started | Phase 2 |
| T-054b | SSE streaming display: render Claude response token-by-token; show "thinking..." indicator; source citation chips | Frontend | 0.5d | P0 | FE Eng 1 | S-14 | Not Started | Phase 2 |
| T-054c | Context injection: on open, pass current screen name + active sym + Redux portfolio + watchlist to API request | Frontend | 0.5d | P0 | FE Eng 1 | S-14 | Not Started | Phase 2 |
| T-055a | `POST /api/v1/copilot`: assemble context (portfolio, live prices, watchlist, current page data); prepend as system prompt | Backend | 0.5d | P0 | Backend | S-14 | Not Started | Phase 2 |
| T-055b | Stream Claude response via SSE (`data: {token}` events); include `[CITED: source]` markers for citation rendering | Backend | 0.5d | P0 | Backend | S-14 | Not Started | Phase 2 |

### Cmd+K (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-076a | Replace SEARCHABLE_STOCKS with live `GET /api/v1/search?q={query}` (debounce 300ms); show sector + market cap in result | Frontend | 0.5d | P1 | FE Eng 1 | S-14 | Not Started | Phase 2 |
| T-076b | Contextual suggestions by page: Earnings → upcoming dates; Movers → top mover tickers | Frontend | 0.5d | P1 | FE Eng 1 | S-14 | Not Started | Phase 2 |

### Story Stocks (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-069a | Story Card component: what/why/what-changed-today/next-catalyst/peer-impact layout; AI badge + source link | Frontend | 0.5d | P0 | FE Eng 2 | S-13 | Not Started | Phase 2 |
| T-069b | Story Stocks feed: scrollable card list; subscribe to `feed:story_stocks`; prepend new cards on event | Frontend | 0.5d | P0 | FE Eng 2 | S-13 | Not Started | Phase 2 |
| T-070a | Story detection worker: every 5 min, scan Firestore news for clusters (>3 articles same sym in 2h); flag sym as "story active" | Backend | 0.5d | P1 | Backend | S-13 | Not Started | Phase 2 |
| T-070b | Story card AI job: on story_active flag, call Claude with news cluster + price/volume; generate story card JSON; publish to Firestore + Redis | Backend | 0.5d | P1 | Backend | S-13 | Not Started | Phase 2 |

### Learn in 60 Seconds (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-064a | Micro-card component: page-triggered (bottom-right), headline + 3 bullets + real example + "Got it"/"Save"; store dismissed IDs in localStorage | Frontend | 0.5d | P1 | FE Eng 1 | S-09 | Not Started | Phase 2 |
| T-064b | Trigger map: 13F page → "What is a 13F?"; Earnings detail → "Why guidance matters"; VIX → "What VIX levels mean"; Options board → "Reading unusual options flow" | Frontend | 0.5d | P1 | FE Eng 1 | S-09 | Not Started | Phase 2 |

### Industry Rotation Alerts (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-074a | Daily job: rank all ~197 industry groups by 1-month + 3-month composite RS; store in Firestore `group_rankings/{date}` | Backend | 0.5d | P1 | Backend | S-15 | Not Started | Phase 2 |
| T-074b | Compare today vs yesterday rankings; if group enters/exits top 20, dispatch push + email via BullMQ | Backend | 0.5d | P1 | Backend | S-15 | Not Started | Phase 2 |

### Mobile App (Phase 2)

| ID | Task | Type | Est. | Pri | Assignee | Sprint | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| T-056a | Scaffold React Native app (Expo + TypeScript); bottom tab bar: Dashboard / Earnings / Movers / Portfolio / Alerts | Mobile | 1d | P0 | Mobile Eng | S-15 | Not Started | Phase 2 |
| T-056b | Firebase Auth in RN: `@react-native-firebase/auth`; share session with web via same Firebase project | Mobile | 0.5d | P0 | Mobile Eng | S-15 | Not Started | Phase 2 |
| T-056c | Push notifications: FCM via `@react-native-firebase/messaging`; register device token on login; triggered from alert worker (T-041b) | Mobile | 0.5d | P0 | Mobile Eng | S-15 | Not Started | Phase 2 |
| T-056d | Mobile-optimized views for Dashboard + Portfolio: single-column layout, no sidebar, simplified charts | Mobile | 1d | P0 | Mobile Eng | S-15 | Not Started | Phase 2; shared API layer |

---

## Task Count Summary

**Nav groups: Intelligence / Context / My Money**

> **"In Review" column added 2026-07-22** = BUILT-NOT-LIVE: written and deployed,
> but production cannot execute or reach it (almost all of it blocked by T-148b,
> the browser↔backend gap). It is counted separately from **Done** on purpose —
> folding it into Done would report five features as delivered that no user can
> currently use.

| Area | Nav Group | Done (live) | In Review (built, not live) | Not Started | Total |
|---|---|---|---|---|---|
| Core Infrastructure | — | 8 | 0 | 26 | 34 |
| Data Ingestion | — | 11 | 1 | 21 | 33 |
| Landing Page | Pre-App | 1 | 0 | 0 | 1 |
| Auth Pages | Pre-App | 2 | 0 | 4 | 6 |
| Dashboard | Intelligence | 8 | 0 | 18 | 26 |
| Earnings | Intelligence | 1 | 0 | 22 | 23 |
| Market Movers | Intelligence | 2 | 0 | 8 | 10 |
| Market Heatmap | Intelligence | 1 | 0 | 0 | 1 |
| Analyst Actions | Intelligence | 4 | 0 | 5 | 9 |
| Screener | Intelligence | 4 | 0 | 0 | 4 |
| Themes | Intelligence | 1 | 0 | 0 | 1 |
| IPOs | Intelligence | 1 | 0 | 0 | 1 |
| Stock Detail | Intelligence | 7 | 1 | 10 | 18 |
| Options Chain | Intelligence | 1 | 0 | 4 | 5 |
| Insider & Inst. | Intelligence | 2 | 0 | 10 | 12 |
| Commentary | Context | 6 | 0 | 0 | 6 |
| Recaps | Context | 3 | 0 | 10 | 13 |
| Macro & VIX | Context | 2 | 0 | 4 | 6 |
| Portfolio Pulse | My Money | 6 | 0 | 8 | 14 |
| Watchlist | My Money | 5 | 0 | 6 | 11 |
| Shell & Design | Platform | 21 | 0 | 0 | 21 |
| Subscription & Plans | Platform | 6 | 2 | 3 | 11 |
| Admin Console & Analytics | Platform | 4 | 1 | 3 | 8 |
| AI Copilot | Platform | 0 | 0 | 5 | 5 |
| Cmd+K | Platform | 0 | 0 | 2 | 2 |
| Story Stocks | Platform | 0 | 0 | 4 | 4 |
| Learn 60s | Platform | 0 | 0 | 2 | 2 |
| Industry Alerts | Platform | 0 | 0 | 2 | 2 |
| Mobile | Platform | 0 | 0 | 4 | 4 |
| **TOTAL** | | **108** | **5** | **181** | **294** |

**Delta since 2026-07-21:** +41 tasks tracked (253 → 294); Done 80 → 108; a new
**In Review** bucket of 5. The 28 newly-Done tasks are concentrated in Data
Ingestion (Polygon deep wiring, T-143a–L) and the additional
subscriptions/entitlements/admin workstream (T-146/T-147) — the latter is
**outside** the 36-row weekly delivery plan and is excluded from that plan's
percentages in `Doc/DELIVERY-PLAN-STATUS.md`.

**The four tasks that matter most are all Not Started:** T-148a (no Cloud
Scheduler — nothing refreshes automatically in production), T-148b (browser
cannot reach the backend — the cause of all 5 In Review items), T-148c (the
security prerequisite for T-148b), T-148d (un-rotated Polygon key). None needs
a vendor purchase; together they are the difference between "the code exists"
and "the product runs".
