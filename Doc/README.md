# MarketCatalyst — Market Intelligence Terminal

> ## ⏱ State sync — 2026-08-16 · SCALE-TO-ZERO worker + premarket Cloud Run Job
>
> _Newest and authoritative on the sync/deployment topology where it differs from
> the blocks below. Only the premarket delivery mechanism and worker scaling
> change; the on-demand data layer, two-service split, and CDN rewrite are
> unchanged._
>
> **Worker scales to zero now (bill ~$75–90/mo → <$15/mo).** The worker service
> `market-catalyst-backend` was always-on (`--min-instances=1` +
> `--no-cpu-throttling`, ≈$65/mo) *only* to host the detached premarket bundle
> (returns `202`, runs past Cloud Run's 900s request limit). It is now
> `--min-instances=0` + CPU throttling — it handles the short scheduled jobs +
> admin and cold-starts per trigger. Safe because the remaining `@Cron` handlers
> (auto-purge/retention) are gated off (`ENABLE_SCHEDULED_JOBS` unset → no-ops)
> and the `@Interval` metering flush (`api-usage.service`) flushes on
> `onModuleDestroy`/SIGTERM — the pattern already proven on the live service.
>
> **Premarket bundle → Cloud Run Job `premarket-job`.** Same image, entrypoint
> overridden to `node dist/job-entry.js` (`src/job-entry.ts` boots a Nest
> application context via `src/app-job.module.ts` — the worker's modules minus
> `ServeStaticModule`, which crashes a no-HTTP context — runs
> `SyncRegistry.get(SYNC_JOB ?? "premarket")()` then exits). Task-timeout 3600s,
> max-retries 1, 2Gi/1cpu, SA `backend-runtime@`; ~18 min/weekday (~$0.50/mo).
> Triggered by Cloud Scheduler `run-premarket-job` (`0 8 * * 1-5` ET) via the Run
> Admin API (`…/jobs/premarket-job:run`, OAuth, `scheduler-invoker@` with
> `roles/run.invoker` on the job). The old `sync-premarket` HTTP scheduler +
> detached `POST /sync/premarket/run` are gone; manual run is now
> `gcloud run jobs execute premarket-job`. See `deploy/DEPLOY.md` §3c/§5.
>
> **Intraday schedulers relaxed 2 min → 5 min** (`*/5 9-16 * * 1-5` ET):
> `sync-market-quotes`/`movers`/`breadth`/`indices`/`fear-greed`.
>
> **On-demand completeness (D) + earnings full-US (E).** `/live/company`'s
> first-time fetch now returns the full detail-page dataset (technicals + RS/tech
> rating ranked against the cached universe, persisting ~2yr bars so the nightly
> crons also rank the new ticker), so the premarket warm is no longer the only
> path to a complete company doc. The forward earnings calendar now covers the
> full US reporter set (resolved against the ~13k Polygon `tickers` reference,
> not just the ~385 tracked `companies`).
>
> ---
>
> ## ⏱ State sync — 2026-07-27 · TWO ENVIRONMENTS (stage + prod), env-driven config
>
> _This block is newest and authoritative where it differs from the blocks
> below. It introduces a second, fully-isolated environment; nothing about the
> per-environment runtime topology (§6, the on-demand data layer, the CDN
> rewrite) changes — that topology now simply exists twice, once per project._
>
> **This doc, specifically:** Extend the Deployment & Known Gaps section —
> MarketCatalyst now runs in two isolated Firebase projects (prod
> `market-catalyst-502415`, stage `market-catalyst-stage`); stage's static UI is
> live at `market-catalyst-stage.web.app`, its backend is not yet deployed
> (blocked on billing).
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
> **This doc, specifically:** For the README: the deploy is a two-service Cloud Run split behind Firebase Hosting/Auth/Firestore.
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


A subscription-based active-investor research platform that consolidates earnings, analyst actions, market movers, screening, insider/institutional flows, macro, and portfolio tools into a single dark-themed terminal. Built with Next.js 16 App Router (static export), Firebase Auth + Firestore, and Redux Toolkit.

15 of 18 screens now read at least some live data, additively merged onto the original mock UI (nothing was deleted to make room for it) — see `Doc/screen-data-sources.md` for the accurate, per-screen breakdown of what's real vs. still illustrative, and why. Options Chain's main bid/ask/IV/greeks/OI table stays simulated (Polygon's options snapshot is confirmed 403 on the current plan; would need an upgrade or a Tradier key), and Recaps remains fully static (blocked on `ANTHROPIC_API_KEY` + a new job).

Recent additions (2026-07-08/09): full US ticker universe (~10,000+ tickers, price-only) wired to the Cmd+K search bar; Screener's RS Rating now computed from real OHLCV history instead of not existing at all; news upgraded to Polygon-primary (adds sentiment/reasoning/keywords) with Finnhub as automatic fallback; Portfolio's computed totals (`totalValue`/`dayPL`/`dayPLPct`) are now materialized into Firestore alongside the existing holdings CRUD, so something outside the browser can read portfolio value without recomputing it; a missing Firestore composite index on `ohlcv_bars` (`ticker`+`barDate`, needed by RS Rating and the Stock Detail chart) was found and deployed via a new `firestore.indexes.json`.

Ops tooling (2026-07-09, backend-only — not part of the MarketCatalyst app itself): every sync job now declares which Firestore collection(s) it writes and its cron schedule once, at registration (`backend/src/common/sync-registry.service.ts`); `sync_meta/{jobName}` persists this alongside every run result, and `GET /sync/jobs` additionally computes each job's next scheduled fire time on the fly (via the same `cron` library `@nestjs/schedule` uses internally, so it can't drift from what actually fires). A new `POST /sync/run-all` triggers every job sequentially for manual testing. `backendUI/index.html` (a static ops dashboard, `npx serve -l 4200 backendUI`) surfaces all of this — collections affected, interval, next run — plus a confirm-gated "Run all now" button.

Changes (2026-07-12):
- **Vendor migration to Polygon** — `dividends` (`/v3/reference/dividends`), `ipos` (`/vX/reference/ipos`), `sectors` (SPDR sector-ETF proxies), `market-indices` (ETF-proxy daily aggs), and `company profile` are now **Polygon-primary** with the previous vendor (FMP/Finnhub) kept as automatic fallback; each doc carries a `source` field recording which vendor served the run. **P/E is now computed from Polygon `/vX/reference/financials` (TTM diluted EPS)**, closing the gap that Polygon's ticker-reference endpoint has no ratios. Adapter routing lives in `backend/src/adapters/adapters.module.ts` and is env-var driven (`COMPANY_PROFILE_SOURCE`, `MOVERS_SOURCE`, `MOVER_ENRICHMENT_SOURCE`). Still NOT on Polygon (no product exists): earnings calendar + analyst consensus (FMP; Polygon 404s), peers + dividend yield (null on Polygon-served docs), macro (FRED), SEC filings (EDGAR).
- **sync_meta last-success / last-failure tracking** — `sync_meta/{jobName}` now persists `lastSuccessAt`/`lastSuccessCount` and `lastFailedAt` in separate fields (written only on that outcome, via Firestore merge), so one outcome never erases the other; `/sync/jobs` and the ops dashboard show "last ran OK" and "last failed" side by side. The dashboard also distinguishes Firestore-unreachable (`metaError`) from a genuine "never run".
- **Stock Detail candles fixed** — `useOhlcvBars` queried `orderBy('barDate','asc')`, which no deployed composite index served (only `ticker ASC, barDate DESC` exists), so every query errored and fell back to synthetic candles; it now queries DESC and reverses in memory. Live candles work for backfilled tickers on 3M/6M/1Y.
- **Live market-status indicator** in the shell header (Open / Pre-Market / After Hours / Closed), computed from real ET time + a US market-holiday list (`app/iq/market-status.ts`).
- **Computed indicator/score jobs (no vendor, no key, bounded storage)** — new jobs derive proprietary metrics from data already synced and upsert them onto `companies/{ticker}` (latest-snapshot): `technical-indicators` (RSI-14, MACD, RVOL from `ohlcv_bars`), `tech-rating` (1-99 composite momentum/trend/RSI + stock rank within sector), `fundamentals-growth` (YoY revenue/EPS growth + gross margin from Polygon `/vX/reference/financials`), and `fear-greed` (a CNN-style 0-100 index → `market_sentiment/fear_greed` from SPY momentum, market breadth, VIX, and SPY-vs-TLT safe-haven). All math validated against Polygon's own indicator API / 10-K figures. Wired into the UI: Stock Detail RSI/MACD + in-sector rank, Screener Tech Rating/RVOL/growth/margin columns+filters, Movers RVOL, Dashboard Fear & Greed gauge — each falling back to the prior seeded value until its job runs.
- **Multi-source news aggregation** — `AggregatingNewsAdapter` (`NEWS_SOURCE=aggregate`, now default) fetches Polygon + Finnhub in parallel and merges/de-dupes per ticker, instead of primary-or-fallback; each article keeps its `source`. (Alpha Vantage / Mediastack keys are stored but not wired — their free tiers, 25/day and ~3/day, are too small for the per-ticker job; they belong on a separate low-cadence market-news job.)
- **Ticker search by company name** — `ticker-universe.job` now also writes `nameLower` (case-insensitive) and `searchTokens` (name words + ticker) onto `tickers/{ticker}`; `useTickerSearch` runs three parallel queries (ticker prefix + name prefix + token) and merges. Requires a ticker-universe re-run to backfill the fields. Firestore can't do mid-word/alias search ("google" → "Alphabet Inc."); the shell's curated list does substring matching for the top names.
- **Firestore purging guidance** — the unbounded time-series (`ohlcv_bars` #1, then `news`, `*_history`, SEC data) should use **native TTL policies** (`expireAt` field per collection: `ohlcv_bars` = barDate+~400d, `news` = publishedAt+~90d). All new compute jobs write **bounded** snapshots, adding nothing to growth. The one-time backfill write bursts need Firestore on **Blaze** (Spark's 20k-writes/day cap is what surfaced the `RESOURCE_EXHAUSTED` errors).

Reliability & hardening (2026-07-12):
- **Crash isolation** — frontend gains Next.js error boundaries (`app/error.tsx` route-level, `app/global-error.tsx` root-level): a component error shows a recoverable fallback instead of a white screen, and the rest of the app keeps working. Backend `main.ts` gains process-level `unhandledRejection`/`uncaughtException` handlers so a single failing cron/sync job logs and the API keeps serving (never tears the process down), plus `enableShutdownHooks()` for graceful SIGTERM/SIGINT.
- **Proper logging** — backend `console.log` replaced with the Nest `Logger` (tagged `[Bootstrap]`/`[Process]`, stack traces on errors).
- **Error monitoring (Sentry)** — `@sentry/browser` (frontend, inited in `app/sentry-init.tsx`) and `@sentry/node` (backend, inited in `main.ts`), wired into the error boundaries + process handlers. **DSN-gated: a safe no-op until `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` are set**, then monitoring turns on with no further code. `tracesSampleRate: 0` (errors only, negligible overhead).
- **Dead code removed** — unused `app/dashboard/{sidebar,back-button,sign-out-button,user-avatar}.tsx` (0 imports; `auth-guard`/`menu-items` kept).
- **Unimplemented buttons wired** — Analyst "My names"/"PT >15% move" filters, Screener "Save screen" (persists filters to localStorage), Settings "Delete account" (Firebase `deleteUser` behind a typed confirmation). Payment/AI/transcript buttons deliberately left (blocked on Stripe/Claude/data — not faked).
- **Forgot-password fix** — no longer leaks account existence: an unknown email shows the same neutral "if an account exists…" message as a real one (was showing a nonsensical "Email or password is incorrect"), and the redundant `window.alert` was removed. *Verified live.*
- **Profile image control** — the raw file input is now a styled **Upload/Change image button** (hidden native input), and the "Stored as profile_image" hint string was removed.
- **Dev-server note** — the recurring Turbopack `FATAL /shot-helper/page` panic is caused by the screenshot tooling injecting/removing a transient route, leaving orphaned `.next` output; `rm -rf .next` + restart clears it. It does not affect production (static export) or normal Turbopack dev.

Changes (2026-07-22) — Polygon data wiring:
- **Two new sync jobs.** `intraday-bars.job.ts` writes 5-min and 30-min bars to `intraday_bars/{ticker}_{5min|30min}` — one document per ticker+resolution holding an *array* of bars, not a document per bar (`25 16 * * 1-5` ET). `corporate-actions.job.ts` writes `dividend_history/{ticker}` (full payment history, annual totals, TTM total, derived yield, 5-yr CAGR, increase streak) and `splits/{ticker}` (`40 6 * * *` ET). 25 sync jobs total, up from 17.
- **5 years of history, filling both directions.** `stock-history.job` backfills 5 years instead of 300 days, clamped to the Polygon plan's rolling 5-year edge. Raising the constant alone did nothing, because `lastSyncedThrough` only ever advances — a new `earliestSyncedFrom` watermark is what lets history fill *backwards*. `vwap` is persisted per bar.
- **Every chart timeframe is now real.** `useChartBars` replaces the daily-only `useOhlcvBars`: 1D/1W from 5-min bars, 1M from 30-min bars, 3M–5Y from `ohlcv_bars`. Previously 1D/1W/1M/5Y all fell through to `genOHLC`, a seeded random walk.
- **US10Y was wrong and is now right.** `market-indices.job` sourced it from the TLT ETF, which moves *inversely* to the yield it was labelled as; it now reads Polygon's `/fed/v1/treasury-yields` (`isProxy:false`, `unit:"percent"`).
- **Richer derived data** — `technical-indicators` adds `rsi14Series` (90-point rolling RSI), SMA/EMA ladders (10/20/30/50/100/200), `vwap`, `high52`/`low52` and the distances from them, `avgVolume20`/`avgVolume50`. `financials.job` now stores the balance sheet, cash flow, margins and current ratio it was already fetching and discarding. `options-chains` adds per-contract OHLC, VWAP and trade count. `polygon-company-profile.adapter` now populates `peers`, `dividendYield` and `dividendPerShare`, previously declared unsupported — that was wrong.
- **Real dividend/split history in the UI** — `useDividendHistory` and `useSplits` replace client-side extrapolation that derived quarterly amounts as `annual / 4` decayed 6.5%/yr and reported a literal constant "+6.5% 5-yr growth" for every company. Splits are shown, not just stored, because `stock-history` refetches with `adjusted=true`, so a split silently rewrites price history.
- **Market status from the vendor** — `src/live/market-status.service.ts` + `GET /live/market-status` (60s cache) replace the browser's local clock plus a hand-maintained holiday list that had to be extended every year and treated early-close half-days as full sessions. The snapshot cache moved to Polygon's **v3 universal snapshot**, adding early/late/regular trading change percentages, which `useExtendedHours` uses to replace hardcoded `PREMARKET`/`AFTERHOURS` arrays.
- **Plan limits, probed live (Polygon Stocks Starter)** — exactly **900 s (15 min)** delay, exactly **5-year** rolling history. Still 403: options snapshot (greeks/IV/OI/bid-ask), index values (I:SPX, I:VIX), trades/quotes, Benzinga. So Options Chain's greeks table stays simulated.

Changes (2026-07-22) — subscriptions, entitlements, admin analytics:
- **New backend module `src/plans/`** — `GET /plans` (public pricing), `POST /plans/seed` (admin), `GET /users/:uid/entitlements` (admin), and admin read-models `GET /admin/users|subscriptions|revenue`. Three plans live in Firestore: Free (0), Plus (2999), Pro (4999) — **minor units, i.e. cents; 4999 is $49.99**, matching Stripe's convention. The registry is a merge-based *seed*, so pricing and packaging change without a redeploy and operator edits survive a re-seed.
- **The tier ladder is cumulative and composed, not hand-written three times**: Free grants marketCatalyst/news/scanner/heatmap/macro/ipos/chartsDaily/watchlist; Plus adds chartsIntraday/chartsHistory/chartIndicators/chartNotes/technicalRatings/dividendHistory/peers/earningsDetail/portfolio/screener/themes/alerts; Pro adds fundamentalRatings/ownership/optionsChain/exportData/apiAccess/aiAssistant/backtesting/paperTrading. `adminDashboard` and `userManagement` are forced **false on every plan** — they are staff capabilities, and selling them would be privilege escalation, which is why Pro is 28 of 30 rather than 30 of 30.
- **Gating is TWO layers, ANDed — deliberately not merged.** `FF_*` release flags answer "is it built and shipped?"; plan entitlements answer "may this tier use it?". A feature renders only when both are true, and the two failures need different UI: **"coming soon"** vs **"upgrade to unlock"**. Collapsing them would make an unbuilt feature look like a paywall. `backtesting` and `paperTrading` prove the point — granted on Pro, not implemented, so they report `released:false` and say "coming soon" instead of taking money.
- **Expiry is computed, never trusted.** Nothing rewrites a user document when a subscription lapses, so a stored `ACTIVE` would grant paid access forever; the stored status is treated as intent and the date as truth, on both the backend (`SubscriptionsService`) and the client. A lapsed subscription falls back to **Free, never to no access**.
- **New frontend gating** — `app/iq/entitlements.tsx` (`EntitlementProvider`, `useSubscription`, `useEntitlement`, `EntitlementGate`, `formatAmount`) and `app/iq/entitlement-gate.tsx` (`PlanGate`, `useSlugEntitled`, `SLUG_ENTITLEMENT`). Live `onSnapshot` listeners on `plans` and `users/{uid}`, so a pricing change reaches users with no redeploy and no reload.
- **Feature-adoption tracking** — `app/iq/feature-adoption.ts` + `track-feature.tsx`, 48 tracked surfaces: screens derived from `menuItems` (so nav and catalog cannot drift) plus in-app actions (8 Stock Detail drawers, chart timeframes/indicators/expand, watchlist add/remove, search, screener, news). One doc per (feature, user), 30-second dedupe, failures swallowed — analytics must never break the screen it measures.
- **Admin console at `/admin`** — the original static `public/admin/console.html` embedded verbatim in an iframe by `app/admin/page.tsx`, which owns the Firebase session and admits only the admin account. Real data is built by `app/admin/admin-data.ts` and staged in `sessionStorage` **before the iframe mounts**, because the console renders once at module scope — `postMessage` would arrive too late. The iframe has no Firebase SDK, so entitlement toggles are delegated back to the React parent over `postMessage` and written with a dotted field path (`featureFlags.<key>`) so a concurrent edit to another flag is not clobbered. Fabricated trend deltas and the fake MRR chart are suppressed whenever real data is present. A **Monitor** tab lazily embeds the backend ops UI.
- **Staff accounts are excluded from every admin metric.** The admin is not a customer: counting it adds a phantom user, shifts the plan mix, drags ARPU down and changes the churn denominator — at this user count that is a 20%+ distortion, not a rounding error. `excludedStaff` is returned so the exclusion is auditable.
- **Firestore rules** — `isAdmin()` = `token.admin == true` OR `token.email == ADMIN_EMAIL`, deliberately *without* an `email_verified` check (the admin is a password account with `emailVerified=false`; requiring it locked the admin out of Firestore while the backend guard still let the same account in). Admins may update **only** `featureFlags` + `updatedAt` on `plans` — price and currency stay server-only, since a client that could rewrite `amount` could set a plan to $0. `feature_adoption` is the only client-writable analytics collection (the browser cannot reach the backend), constrained so a row must belong to the caller and `openCount` may only increase. Also fixed two pre-existing bugs: `market_sentiment` and `stock_comments` had **no rule at all**, so default-deny silently broke the Dashboard Fear & Greed gauge (it fell back to a hardcoded 62/"Greed") and chart notes.
- ⚠ **Both repos ship a `firestore.rules` and they have drifted.** The live ruleset is deployed from `MarketCatalystUI/firestore.rules`; the backend copy is stale and now carries a DO-NOT-DEPLOY header.
- **New collections**: `intraday_bars`, `dividend_history`, `splits`, `plans`, `payments`, `subscriptions`, `feature_adoption`, `api_usage`, `audit_logs`, `revenue_summary`, `system_metrics`. Populated today: `intraday_bars` (474), `dividend_history` (241), `splits` (241), `plans` (3), `feature_adoption` (~12 seeded). Empty: the rest.

---

## Deployment & Known Gaps (2026-07-27)

**Two environments (isolated Firebase projects).** Production = `market-catalyst-502415`; **stage** = `market-catalyst-stage` (own Firestore in nam5, same rules/indexes, own Auth + `backend-runtime` SA, prod data copied in). Both repos work on the `stage` branch. Firebase config is env-driven: backend `FIREBASE_PROJECT_ID`, UI `NEXT_PUBLIC_FIREBASE_*` (UI stage build via `.env.production`).

**Deployed (prod):** frontend at `https://marketcatalyst.web.app` (Firebase Hosting, static export, project `market-catalyst-502415`); backend on Cloud Run (`market-catalyst-backend` worker `--no-allow-unauthenticated` + public `market-catalyst-live`, us-central1, `min-instances=0`); Firestore rules released. **Stage:** static UI live at `https://market-catalyst-stage.web.app`; stage backend not deployed yet (blocked on stage billing).

Stated plainly, because each one limits what the deployed system can do:

1. **~~The browser cannot reach the backend~~ — RESOLVED.** The UI now resolves its backend base URL at runtime (`app/iq/backend.ts`): `localhost:4400` in dev, **same-origin** when deployed, with `firebase.json` rewriting `/api`, `/market-data` and `/live` to the public `market-catalyst-live` service (no CORS, CDN-cached). A localhost `NEXT_PUBLIC_BACKEND_URL` is ignored on a deployed host. Remaining prerequisites: keep `ADMIN_GUARD_TRUST_IAM=false` on any public route, and on **stage** the rewrites need billing (Cloud Run API) before they can deploy.
2. **No Cloud Scheduler jobs exist in any region**, and there is no `scheduler-invoker` service account — `create-scheduler-jobs.sh` was never run. With `min-instances=0` the in-process `@Cron` decorators never fire, so **no sync job has ever run automatically in production**; every row currently in Firestore came from a manual run.
3. **`POLYGON_API_KEY` is un-rotated** (exposed in chat). Secret Manager version 4 is enabled; `deploy/rotate-polygon-key.sh` automates everything except generating the replacement key.
4. **Stripe is not implemented.** No Stripe code exists in either repo, `stripePriceId` is `null` on every plan (which keeps them non-purchasable), and `payments`/`subscriptions` are empty. Checkout and webhooks are blocked on gap 1.
5. **`api_usage` is specified but not implemented** — no middleware records API calls, so the admin console's "Usage & API" KPIs read 0.
6. **Per-user engagement columns read 0** (watchlists/holdings/apiCalls/alerts) — there is no collection behind them yet. Reported as 0 rather than estimated: the console's own PRNG-invented figures would look authoritative next to real users.

---

## Backend (`backend/`)

A separate NestJS service, not part of this Next.js app, syncs vendor data (Polygon, FMP, Finnhub, FRED, SEC EDGAR) into Firestore on cron schedules — this app reads the results via the Firestore client SDK, same as any other collection, and never calls a vendor directly or holds a vendor key. See `backend/README.md` for how to run it, `Doc/openapi.yaml` for the full documented data contract, and `Doc/schema.sql` for the equivalent relational schema if this ever migrates off Firestore.

### Data flow (verified 2026-07-09)

```
Vendor APIs (Polygon, FMP, Finnhub, FRED, SEC EDGAR)
        │  25 NestJS cron jobs, each on its own periodic interval
        │  (daily/weekly/every-30-min — see backend/README.md's job table)
        ▼
   Cloud Firestore  (backend/src/common/firebase-admin.provider.ts — Admin SDK, server-only)
        │  onSnapshot() real-time listeners (app/iq/hooks/*)
        ▼
   Next.js app (this repo) — every live screen element
```

The backend also exposes real REST routes (`/plans`, `/users/:uid/entitlements`,
`/admin/*`, `/live/*`), but **the browser cannot reach them in production** — see
Deployment & Known Gaps above. Everything the app renders today still arrives via
the Firestore client SDK.

Confirmed end-to-end, not assumed:
- Every one of the 25 sync jobs in `backend/src/sync/*.job.ts` has a real `@Cron(...)` schedule — none are one-off or manually-triggered-only. (They do not currently *fire* in production; see gap 2.)
- Zero vendor API domains or vendor API keys are referenced anywhere in `app/` (grepped for Polygon/FMP/Finnhub/FRED/SEC EDGAR URLs and every `NEXT_PUBLIC_*_API_KEY` var name — no matches).
- `.env.local` (frontend env) had 3 live, populated `NEXT_PUBLIC_*` vendor keys left over from before the backend migration, unused by any code — blanked out 2026-07-08 as a security cleanup (was gitignored, never committed, so not a git-history leak, but no reason for a live credential to sit there once the frontend stopped calling vendors directly).

Where the requirement isn't yet fully met: not every screen element has a live source wired up yet (some genuinely have none — AI content needs Claude, some are intentionally curated/editorial, not vendor data at all). See `Doc/screen-data-sources.md` for the exhaustive, per-element breakdown of what's live vs. still illustrative, and exactly why for each one.

---

## Project Structure

```
app/
├── page.tsx              # Landing page (/) — marketing page with inline login modal
├── layout.tsx            # Root layout — imports global CSS, sets <html> attributes
├── iq.css                # Design system — CSS custom properties, layout primitives, component classes
├── landing.css           # Landing-page styles — hw-* classes, animations, modal overlay
├── auth/
│   ├── auth-layout.tsx   # Two-panel auth layout (left: marketing, right: glassmorphism card)
│   ├── login/            # /auth/login — standalone login page (AuthLayout + LoginForm)
│   ├── signup/           # /auth/signup — signup page (AuthLayout + SignupForm)
│   └── forgot-password/  # /auth/forgot-password — password reset page
├── dashboard/            # /dashboard — main app shell (IQShell)
├── admin/                # /admin — admin console gate (session + postMessage bridge)
│   ├── page.tsx          #   auth gate, sessionStorage staging, plan-flag/logout/password bridge
│   └── admin-data.ts     #   buildAdminDataset() — Firestore → console row shape; ADMIN_EMAIL
├── iq/
│   ├── shell.tsx         # IQShell — sidebar nav, topbar, drawer system, Cmd+K, Copilot panel
│   ├── stock-panel.tsx   # Shared components: StockScreenEmbed, StockRow, StockListCard, ChartCard, StockPanelLayout
│   ├── utils.tsx         # Shared chart + utility components: CandleChart, RsiPane, TrGauge, SemiGauge, Spark, hashStr, earnHistory
│   ├── feature-flags.tsx # RELEASE layer — FF_* flags: "is it built and shipped?"
│   ├── entitlements.tsx  # COMMERCIAL layer — plan entitlements; useEntitlement() ANDs the two
│   ├── entitlement-gate.tsx # PlanGate (upgrade panel), useSlugEntitled, SLUG_ENTITLEMENT
│   ├── feature-adoption.ts  # 48 tracked features (screens + in-app actions), 30s dedupe
│   ├── track-feature.tsx # <TrackFeature> — records an open on mount, renders nothing
│   ├── hooks/            # useChartBars, useCompany, useDividendHistory, useSplits, useExtendedHours, useCollection, …
│   ├── data.ts           # Static mock data: pulse, earnings, movers, analyst, folio, watch, screener, funds, etc.
│   └── screens/          # One file per workspace screen (watchlist, portfolio, themes, screener, analyst, commentary, etc.)
├── menu/[slug]/          # /menu/:slug — 15 workspace screens
├── profile/edit/         # /profile/edit — investor profile setup
└── settings/             # /settings — preferences (dark mode, etc.)

public/
└── admin/console.html    # The admin console itself — standalone static page,
                          # iframed by app/admin/page.tsx (no Firebase SDK inside)
```

---

## Auth Flow

```
Landing (/)
  ├── "Log in" button  →  inline modal on landing page (LoginForm)
  │     └── success    →  /dashboard
  │     └── "Forgot?"  →  /auth/forgot-password  →  "Back to sign in"  →  /
  │     └── "Sign up"  →  /auth/signup
  └── "Sign up" button →  /auth/signup  →  success  →  /dashboard
        └── "Sign in"  →  / (landing page, open modal manually)

Auth pages all carry MarketCatalyst logo → / (landing page)
```

---

## Mobile Responsive

The web app is fully responsive at `≤767px` (mobile) and `≤900px` (auth pages):

- **Shell**: Grid collapses to single-column. Rail becomes a fixed slide-in drawer triggered by a hamburger button (`.mob-ham`). The scrim (`.mob-nav-scrim`) is placed inside `.app` to share the same CSS stacking context as the rail (z-200), preventing it from blocking nav taps.
- **Drawers & Copilot**: Drawers become bottom-sheets (`border-radius` on top corners). Copilot FAB becomes an icon-only 48px circle.
- **Options page**: Expiry tabs scroll horizontally (`flex-wrap: nowrap; overflow-x: auto`). Stock header meta wraps below price at narrow widths.
- **Auth pages**: Two-panel `AuthLayout` collapses at `≤900px` (stacks vertically) and at `≤600px` the marketing panel is hidden — only the form card is shown, full-width.

---

## Navigation

The shell (`IQShell`) wraps every authenticated page with a left sidebar of 14 workspaces grouped into three categories:

| Group | Workspace |
|---|---|
| Intelligence | Dashboard, Earnings, Market Movers, Market Heatmap, Analyst Actions, Screener, IPOs, Stock Detail, Options, Insider & Institutional |
| My Money | Portfolio Pulse, Watchlist, Themes |
| Context | Commentary, Recaps, Macro & VIX |

---

## Design System

Defined in `app/iq.css` via CSS custom properties on `:root`:

| Token | Value | Usage |
|---|---|---|
| `--brand` | `#7C6CF5` | Primary purple |
| `--brand-2` | `#9B8BFF` | Lighter purple accent |
| `--ai` | `#34E2F0` | AI teal / gradient endpoint |
| `--up` | `#2FE6A6` | Positive / gain |
| `--down` | `#FF5470` | Negative / loss |
| `--bg` | `#080B11` | App background |
| `--surface-0/1/2/3` | Dark surfaces | Card backgrounds |

Key component classes: `.pill`, `.pill.up/.down/.ai/.hold/.dn/.amc`, `.card`, `.col-N`, `.tr-badge`, `.ai-block`, `.wmn`, `.filt`, `.dd`

**Mobile classes** (desktop-hidden by default, activated in `@media (max-width: 767px)`): `.mob-ham`, `.mob-brand`, `.mob-rail-head`, `.mob-nav-close`, `.mob-nav-scrim`, `.mob-open` (on `.rail`)

---

## Development

```bash
npm run dev          # dev server (Turbopack)
npm run build        # static export to /out
firebase deploy      # deploy to Firebase Hosting
```

Runs on Next.js 16.2.9 with `output: 'export'`. All 24 routes are pre-rendered as static HTML.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 App Router (`output: 'export'`) |
| Auth | Firebase Authentication (email/password + Google OAuth, iOS Safari-safe via `indexedDBLocalPersistence` + popup-first) |
| Database | Cloud Firestore |
| State | Redux Toolkit |
| Styling | CSS custom properties (no Tailwind) |
| Hosting | Firebase Hosting |
| Backend | Separate NestJS service (`backend/`) — see its own README |
| Data — live | Polygon.io, FMP, Finnhub, FRED, SEC EDGAR (via `backend/`, synced to Firestore) |
| Data — blocked (no key / plan restriction) | Benzinga, Tradier, Unusual Whales |
| AI (planned) | Claude API — needs `ANTHROPIC_API_KEY`, not yet obtained |
| Feature gating | Two layers, ANDed: `FF_*` release flags (`app/iq/feature-flags.tsx`) + plan entitlements (`app/iq/entitlements.tsx`), resolved server-side by `backend/src/plans/` |
| Plans & billing data | 3 plans in Firestore `plans` (Free / Plus 2999 / Pro 4999, minor units); `payments` + `subscriptions` collections exist but are empty |
| Payments (planned) | Stripe — **not implemented**; no Stripe code in either repo, `stripePriceId` is `null` on every plan, and checkout is blocked on the browser→backend gap |
| Admin console | Static `public/admin/console.html` in an iframe; React parent owns the session, stages data via `sessionStorage`, and services writes over `postMessage` |
