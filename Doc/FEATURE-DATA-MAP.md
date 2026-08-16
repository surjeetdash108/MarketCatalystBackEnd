# MarketCatalyst — Feature & Data Source Map

> ## ⏱ State sync — 2026-08-16 · FMP NEWS MERGE · STOCK-DETAIL WIRING · ON-DEMAND COMPLETENESS · FULL-US EARNINGS (deployed to prod)
>
> _Newest and authoritative where it differs from the blocks and per-feature
> rows below. Scoped to per-feature data sourcing; runtime topology, on-demand
> layer and cost architecture are unchanged and not restated here._
>
> **News (A.1.7 / A.6 `NEWS_ADAPTER` / B.1 #12 / B.15 #3) — now a Polygon + FMP
> merge.** The news feed merges Polygon and FMP articles, deduped by URL (Polygon
> wins a collision). Every article carries a `vendor` field (`"polygon"` |
> `"fmp"`), badged in the UI, alongside the publisher `source`, a `sentiment` pill
> and a thumbnail image. Backend: env `NEWS_FMP_SOURCE=fmp`, new
> `src/adapters/fmp-news.adapter.ts` + `NEWS_FMP_ADAPTER` token (types.ts), a
> `news.job.ts` merge loop, and the `/live/news` on-demand path
> (`ondemand.service.ts`) also writes `vendor`; FMP client `getStockNews()` in
> `vendors/fmp/fmp.service.ts` (`/stable/news/stock`). FMP article `sentiment` is
> frequently null. This deliberately reverses the earlier "FMP supplies NEVER …
> news" scope note (redistribution licensing flagged and accepted).
>
> **Stock Detail (B.2) — the full detail-page set now lands on the FIRST
> on-demand fetch.** `/live/company` (`ondemand.getCompany`) previously returned a
> slim profile-only doc, so several B.2 rows were blank until the nightly crons
> caught up. It now returns the FULL set on first fetch: `peRatio`, `eps`,
> `dividendYield`, `dividendPerShare`, `peers`, the technicals (`rsi14`, `macd`,
> `stochK`, `adx14`, `beta`, the SMA ladder, `high52`/`low52` from real bars,
> `keyLevels`) AND the RS + tech rating. A brand-new ticker is ranked on-demand
> against the cached universe's stored score distribution — the crons now persist
> RAW scores (`rs-rating` → `rsScore`; `tech-rating` → `techMomentum`/`techTrend`/
> `techRsi`) precisely so a single ticker can be ranked against them. Existing
> cron ranks stay authoritative; ~2yr of bars are persisted to `ohlcv_bars` so the
> nightly crons rank the ticker too. Shared PURE compute functions back both cron
> and on-demand (`computeIndicators`, `computeRsScore`+`rsPercentile`,
> `computeTechComponents`+`techRatingFromComponents`).
>
> **Dashboard popups (B.1 #7 / #16).** The analyst popup now renders price-target
> median/low-high + recent grades (was a stale "not built yet" note). The mover
> popup null-guards RVOL / RS — a ticker without them no longer renders a
> fabricated "0×" / "0/99".
>
> **IPOs (B.17 / A.1.6) — Shares + Deal size columns are now shown**
> (`numberOfShares` / `totalSharesValue`) — the fields were already synced, just
> not surfaced.
>
> **Earnings (B.3 / B.4 / A.2.1) — the forward calendar now covers the full US
> market.** The forward (FMP) earnings calendar no longer filters to the ~385
> tracked `companies`; `earnings.job.ts`'s `loadRefNames` resolves every FMP
> calendar symbol against the ~13,106-row Polygon US ticker reference (`tickers`,
> written by `ticker-universe.job`), keeping CS/ADRC US listings with Polygon
> names and dropping FMP's worldwide rows. Reported/historical rows were already
> full-US (Polygon `getFinancialsByFilingDate`). Aug 26 2026 went 4 → 38
> reporters; `earnings_events` ~7.3k → ~8.8k. NOTE: `/market-data/earnings` still
> returns the whole collection to the client — add date-windowed loading if it
> grows large.

> ## ⏱ State sync — 2026-07-27 · TWO ENVIRONMENTS (stage + prod), env-driven config
>
> _This block is newest and authoritative where it differs from the blocks
> below. It introduces a second, fully-isolated environment; nothing about the
> per-environment runtime topology (§6, the on-demand data layer, the CDN
> rewrite) changes — that topology now simply exists twice, once per project._
>
> **This doc, specifically:** Schema and per-collection mappings are identical
> across both Firestore projects; nothing in this map changes.
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
> **This doc, specifically:** For the data map: TradingView is removed; heatmap/dashboard/stock-detail are now real; the live-price subscription and `/live/collections` cache are new.
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


**Generated:** 2026-07-20 · **Revised:** 2026-07-22 · **Scope:** every user-facing feature in MarketCatalystUI, traced to its data source, the vendor behind it, and a free alternative where one exists.

> **2026-07-22 revision.** Two bodies of work landed after the first pass: **(A) Polygon data wiring** — a large block of features previously classified GENERATED turned out to be *unsynced*, not *unavailable*, on the existing Starter plan, and are now LIVE; and **(B) subscriptions / entitlements / admin analytics** — a new `src/plans/` module, a two-layer gating model, and a real-data admin console (Parts B.23–B.25).
>
> Rows changed by this revision carry a **🆕 2026-07-22** marker. **Nothing was upgraded on faith** — every reclassification below was checked against the shipped code path, and where the UI still falls back to the old fabricated value when the live field is missing, the row says so instead of claiming LIVE. The features listed in §D.5 remain fabricated and were *not* touched.

---

## 0. How to read this document

### Source classification

| Tag | Meaning |
|---|---|
| **LIVE** | Read from Firestore, populated by a backend sync job from a real vendor API. |
| **HYBRID** | Live data overlays a hardcoded base row. Specific numeric fields (price, %chg, market cap) are real; descriptive fields (catalyst text, narrative, session) stay static. **Falls back silently** unless noted. |
| **STATIC** | A hardcoded array/object in the frontend. Never touches a vendor. |
| **GENERATED** | Numbers fabricated in the browser by arithmetic or a seeded PRNG, rendered as if real. |
| **USER** | Data the user entered, persisted to Firestore under `users/{uid}/…`. |
| **NONE** | Pure UI — navigation, layout, filters over already-fetched data. |
| **LIVE→fallback** | 🆕 Real vendor field when the sync job has populated it, **falling back to the old fabricated value when it is null**. Introduced by the 2026-07-22 wiring — used where the code genuinely still carries the old formula as a fallback, so the row is not claimed as unconditionally LIVE. |

### Verification status of claims in this document

| Marker | Meaning |
|---|---|
| ✅ **VERIFIED** | Confirmed by reading source code, or by calling the live endpoint on 2026-07-20 (2026-07-22 for 🆕 rows). |
| ⚠️ **UNVERIFIED** | From vendor documentation knowledge, not tested against a live key. **Pricing and free-tier limits change — confirm before relying on any of these.** |

Everything in Parts A and B is ✅ unless marked. Free-tier claims in Part C are ⚠️ except where a probe result is quoted.

---

## 1. Executive summary

| Metric | Count (2026-07-20) | Count (2026-07-22) |
|---|---|---|
| Screens audited | 19 + app shell + public landing page | 19 + app shell + landing page + **admin console** |
| Features catalogued | ~185 | **224** (incl. plans/entitlements, adoption tracking, admin console) |
| Sync jobs in the backend | 21 | **25** (+ `intraday-bars`, `corporate-actions`, `financials`, `market-breadth`) |
| Firestore collections written **by sync jobs** | 21 | **24** (+ `intraday_bars`, `dividend_history`, `splits`, `financials`, `market_breadth`) |
| Platform collections (non-sync) | — | **8** (`plans`, `payments`, `subscriptions`, `feature_adoption`, `api_usage`, `audit_logs`, `revenue_summary`, `system_metrics`) — 🔴 only `plans` and `feature_adoption` are populated |
| Data vendors wired and in use | 5 (Polygon/Massive, FMP, Finnhub, FRED, SEC EDGAR) | 5 — unchanged |
| Vendor services present but **not wired** | 3 (Benzinga, Tradier, Unusual Whales) | 3 — unchanged |
| API keys declared but unused in code | 3 (`ANTHROPIC_API_KEY`, `ALPHAVANTAGE_API_KEY`, `MEDIASTACK_API_KEY`) | 3 — unchanged |

**Headline finding (2026-07-20):** roughly **one third** of what the app displays is LIVE. The rest is STATIC or GENERATED, and with three exceptions the UI does not tell the user which is which.

**Revised headline (2026-07-22):** the **numeric / market-data layer is now largely real** — charts at every timeframe, RSI, moving-average ladders, VWAP, 52-week range, average volume, peers, dividends, balance sheet and cash flow all read live vendor data on screens where they were previously fabricated in the browser. Purely-live features went **14 → 39** (25 of those on the originally-audited screens), with **9** more live-but-with-a-fabricated-fallback, and GENERATED fell **36 → 21**. See the recounted **B.26** totals.

**What did *not* change, and must not be described as fixed:** every **AI narrative block** in the app is still a template string (`ANTHROPIC_API_KEY` remains unreferenced in `src/`); earnings **estimates / guidance / session**, **analyst per-firm actions**, **short interest**, **institutional ownership %**, **earnings transcripts**, **backtesting**, **paperTrading**, the **alerts engine**, **`api_usage` metering** and **Stripe/payments** are all still absent or fabricated. Options **greeks / IV / open interest** are still `NOT_AUTHORIZED` on the plan. And two of the newly-wired features — **extended-hours moves** and the **vendor market-status pill** — work **locally only**, because the browser cannot reach the backend in production (see §D.4). Part D is the authoritative list.

---

## Part A — Vendor & API reference

Every request below uses **real parameter names** and a **real example value** (`AAPL`, a real date). Every response block is an **actual captured payload from the live endpoint on 2026-07-20**, trimmed to one array element and abbreviated with `…` where long — not a hand-written example. API keys are shown as `***`.

### A.1 Polygon / Massive — primary market-data vendor

| | |
|---|---|
| **Base URL** | `https://api.massive.com` (env `POLYGON_API_BASE_URL`; code default `https://api.polygon.io` still resolves, being phased out after the Oct 2025 rebrand) |
| **Auth** | `?apiKey=***` query parameter |
| **Plan** | Stocks Starter — unlimited rate, 5yr history, 15-min delayed, no tick data, no Options/Indices entitlement |
| **Throttle** | `POLYGON_PAGE_DELAY_MS` = `0` in production (paid tiers unlimited, verified 2026-07-20) |
| **Pagination** | Cursor-based via `next_url`; the code re-appends `&apiKey=` to each follow-up URL |

#### 🆕 A.1.0 Plan entitlements — probed endpoint by endpoint (2026-07-22)

The first pass recorded several features as "blocked on a plan upgrade". **That was wrong for most of them** — they were unsynced, not unauthorized. Every path below was called against the live key:

| Status | Endpoints |
|---|---|
| ✅ **Authorized** | daily aggs · **intraday `/range/{n}/minute/`** · grouped daily · v2 + v3 snapshots · **universal snapshot** · reference tickers / dividends / splits / IPOs / news · **`/v1/related-companies`** (peers) · `/v1/indicators/*` · `/v1/marketstatus/*` · `/vX/reference/financials` · **option CONTRACT aggs** · `/fed/v1/*` (treasury yields) |
| 🔴 **403 NOT_AUTHORIZED** | options **snapshot** (greeks / IV / open interest / bid-ask) · index values (`I:SPX`, `I:VIX`) · trades / quotes / last-trade · `/benzinga/v1/*` · `/v1/summaries` |
| 🔴 **404** | short interest · futures |

**Measured limits:** delay is **exactly 900 s (15 min)**; history is **exactly a 5-year rolling window** (`planHistoryFloor()` clamps every backfill to that edge).

**Consequence:** the Options screen's greeks gap and the index-value gap are *genuine* plan limits. The chart, RSI, MA/EMA, VWAP, 52-week, peers and dividend-history gaps were **not** — they are now wired (see B.2, B.21).

---

#### A.1.1 Ticker universe → `tickers`

**Used by:** `ticker-universe` job (weekly, Sun 03:00 ET)

```http
GET https://api.massive.com/v3/reference/tickers
      ?market=stocks&active=true&limit=1000&apiKey=***
```

```jsonc
{
  "results": [{
    "ticker": "A",
    "name": "Agilent Technologies Inc.",
    "market": "stocks",
    "locale": "us",
    "primary_exchange": "XNYS",
    "type": "CS",
    "active": true,
    "currency_name": "usd",
    "cik": "0001090872",
    "composite_figi": "BBG000C2V3D6",
    "share_class_figi": "BBG001SCTQY4",
    "last_updated_utc": "2026-07-20T06:09:26.144Z"
  }],
  "status": "OK", "count": 1,
  "next_url": "https://api.massive.com/v3/reference/tickers?cursor=YWN0aXZl…"
}
```

| Vendor field | → Firestore field |
|---|---|
| `ticker` | `ticker` (also doc id) |
| `name` | `name`, `nameLower`, `searchTokens[]` |
| `market`, `locale`, `type`, `active`, `currency_name` | same names, camelCased |
| `primary_exchange` | `primaryExchange` |
| `cik`, `composite_figi`, `share_class_figi` | `cik`, `compositeFigi`, `shareClassFigi` |

**Free alternative:** SEC `company_tickers.json` (no key, authoritative for US listings) · Finnhub `/stock/symbol` · Nasdaq symbol directory

---

#### A.1.2 Company profile → `companies`

**Used by:** `companies` job (daily 02:00 ET) · `market-movers` enrichment

```http
GET https://api.massive.com/v3/reference/tickers/AAPL?apiKey=***
```

```jsonc
{
  "results": {
    "ticker": "AAPL",
    "name": "Apple Inc.",
    "market_cap": 4901758191440.0,
    "primary_exchange": "XNAS",
    "cik": "0000320193",
    "sic_code": "3571",
    "sic_description": "ELECTRONIC COMPUTERS",
    "description": "Apple is among the largest companies in the world, with a broad portfolio of hardware and software products…",
    "address": { "address1": "ONE APPLE PARK WAY", "city": "CUPERTINO", "state": "CA" },
    "phone_number": "(408) 996-1010"
  }
}
```

| Vendor field | → Firestore field |
|---|---|
| `name` | `name` |
| `market_cap` | `marketCap` |
| `sic_code` | → `sector` **via `sectorFromSic()`**, not vendor-supplied |
| `sic_description` | `industry` |
| `primary_exchange` | `exchange` |
| `description` | `description` |

🆕 **2026-07-22 — the previous claim here was wrong and has been corrected.** This document (and the adapter) previously flagged `dividendYield`, `dividendPerShare` and `peers` as `FIELD_NOT_SUPPORTED` — "Polygon has no such product". Polygon has both products on this plan; the adapter simply never called them. `polygon-company-profile.adapter.ts` now populates all three:

| Field | Now sourced from |
|---|---|
| `peers[]` | `GET /v1/related-companies?ticker=AAPL` — authorized on Starter |
| `dividendPerShare` | TTM sum from `dividend_history/{ticker}` (built by `corporate-actions`) |
| `dividendYield` | derived — TTM dividends ÷ current close |

**Free alternative:** Finnhub `/stock/profile2` · SEC XBRL `companyfacts` · Alpha Vantage `OVERVIEW`

---

#### A.1.3 Daily OHLCV bars → `ohlcv_bars`, `market_indices`, `sectors`

**Used by:** `stock-history` (03:00 ET) · `market-indices` · `sectors` · `fear-greed` · company-profile price derivation

```http
GET https://api.massive.com/v2/aggs/ticker/AAPL/range/1/day/2026-07-13/2026-07-17
      ?adjusted=true&sort=asc&apiKey=***
```

```jsonc
{
  "ticker": "AAPL", "queryCount": 5, "resultsCount": 5, "adjusted": true,
  "results": [{
    "v": 43257804.46,      // volume
    "vw": 318.1536,        // volume-weighted avg price — 🆕 now persisted
    "o": 317.015,          // open
    "c": 317.31,           // close
    "h": 323.45,           // high
    "l": 315.78,           // low
    "t": 1783915200000,    // epoch ms
    "n": 884512            // trade count (not read)
  }],
  "status": "OK", "count": 5
}
```

| Vendor field | → Firestore field |
|---|---|
| `t` | `barDate` (epoch ms → `YYYY-MM-DD`) |
| `o`, `h`, `l`, `c`, `v` | `open`, `high`, `low`, `close`, `volume` |
| `vw` | 🆕 `vwap` — previously discarded; now the source of the real VWAP row (B.2 #8) |

**Note:** written with `merge:false` and re-fetched with `adjusted=true`, so a stock split rewrites history rather than blending adjustment bases.

🆕 **2026-07-22 — backfill widened from 300 days to 5 years** (clamped to the plan's rolling 5-year edge by `planHistoryFloor()`). This is what makes the **5Y chart** real rather than synthetic.

> **Why raising the constant alone did nothing.** `stock-history.job.ts` tracked only a `lastSyncedThrough` watermark, which only ever *advances* — so a larger lookback window produced no new writes for tickers already synced. The job now also carries an **`earliestSyncedFrom`** watermark, so history fills **backwards** as well as forwards. Without that second watermark the 5-year change is a no-op on any existing ticker.

**Free alternative:** Stooq (free CSV, no key) · Tiingo · Twelve Data · Alpha Vantage. ⚠️ Yahoo's chart endpoint is common but **unofficial and against ToS** — unsuitable for a paid product.

---

#### 🆕 A.1.3b Intraday minute aggregates → `intraday_bars`

**Used by:** `intraday-bars` job (16:25 ET, Mon–Fri) — **NEW**. Serves the **1D / 1W / 1M** chart timeframes, which previously rendered `genOHLC()`.

```http
GET https://api.massive.com/v2/aggs/ticker/AAPL/range/5/minute/2026-07-12/2026-07-22
      ?adjusted=true&sort=asc&limit=50000&apiKey=***
```

Same bar shape as A.1.3 (`o/h/l/c/v/vw/t/n`), at minute resolution. Probed 2026-07-21: **1,553 one-minute bars returned, and still resolving a year back** — this was authorized on Starter the whole time.

Two resolutions cover the three timeframes:

| Resolution | Lookback | Serves |
|---|---|---|
| `5min` | 10 calendar days | **1D**, **1W** |
| `30min` | 45 calendar days | **1M** |

**Storage shape — deliberately not one doc per bar.** `intraday_bars/{ticker}_{5min\|30min}` is **one document per ticker per resolution holding an array of bars**. A doc-per-bar scheme at 5-minute resolution would add ~150 docs per ticker per day (≈35k/day across the universe) purely to be re-read as a contiguous series — and the chart always wants the whole window at once. A ~1000-bar array stays well under Firestore's 1 MB document ceiling.

**Not a live tape.** This job refreshes *after the close*; it exists to give every chart a real historical shape. Intraday freshness during the session comes from the snapshot cache / SSE path for the ticker in view.

**Free alternative:** Alpaca (free IEX intraday) · Twelve Data · Tiingo IEX. ⚠️ Most free tiers cap intraday history at days, not weeks.

---

#### A.1.4 Whole-market grouped daily → `tickers` quotes, `market_movers`, `market_sentiment`

**Used by:** `market-quotes` (18:07 ET) · `market-movers` · `fear-greed` breadth

```http
GET https://api.massive.com/v2/aggs/grouped/locale/us/market/stocks/2026-07-17?apiKey=***
```

```jsonc
{
  "queryCount": 12411, "resultsCount": 12411, "adjusted": true,
  "results": [{
    "T": "FMDE",          // ticker
    "v": 677964.01,       // volume
    "o": 40.28, "c": 40.42, "h": 40.66, "l": 40.28,
    "t": 1784318400000, "n": 4605
  }],
  "status": "OK", "count": 12411
}
```

One call returns **12,411 tickers** — the job calls it twice (latest + prior trading day, walking back over holidays via `candidateTradingDays`) and diffs closes to derive `pctChange`. Mover eligibility: price ≥ $3, volume ≥ 500,000.

| Vendor field | → Firestore field |
|---|---|
| `T` | `ticker` |
| `c` | `price` |
| `v` | `volume` |
| computed | `pctChange = (todayClose − priorClose) / priorClose × 100` |

**Free alternative:** no direct equivalent at this breadth on a free tier — this endpoint is a genuine Polygon strength.

---

#### A.1.5 Dividends → `dividends`

**Used by:** `dividends` job (06:20 ET)

```http
GET https://api.massive.com/v3/reference/dividends
      ?ex_dividend_date.gte=2026-07-01&ex_dividend_date.lte=2026-08-01&limit=1000&apiKey=***
```

```jsonc
{
  "results": [{
    "id": "E396fbae341a40e1373ea57ce984c386f06778209996e5ef713783aa9455588bc",
    "ticker": "GECCG",
    "cash_amount": 0.48975694,
    "currency": "USD",
    "dividend_type": "CD",          // CD = regular, SC = special
    "ex_dividend_date": "2030-12-13",
    "pay_date": "2030-12-31",
    "record_date": "2030-12-15",
    "frequency": 4
  }],
  "status": "OK", "next_url": "…"
}
```

| Vendor field | → Firestore field |
|---|---|
| `ticker` | `ticker` |
| `ex_dividend_date` | `exDividendDate` |
| `record_date`, `pay_date`, `declaration_date` | `recordDate`, `paymentDate`, `declarationDate` |
| `cash_amount` | `dividendAmount` |
| `frequency` (int) | `frequency` — mapped `0:One-Time, 1:Annual, 2:Semi-Annual, 4:Quarterly, 12:Monthly` |
| `id` | appended to the doc id to disambiguate same-day regular vs special dividends |

⚠️ **No dividend yield** on this source (`yieldPct: null`). FMP supplies it — that's why FMP is the fallback.

**Free alternative:** FMP `/stable/dividends-calendar` ✅ (already the fallback, includes `yield`) · Finnhub `/stock/dividend`

---

#### A.1.6 IPO calendar → `ipos`

**Used by:** `ipos` job (06:15 ET)

```http
GET https://api.massive.com/vX/reference/ipos
      ?listing_date.gte=2026-07-01&listing_date.lte=2026-08-01&limit=1000&apiKey=***
```

```jsonc
{
  "results": [{
    "ticker": "PHAXU",
    "issuer_name": "Phalanx Acquisition Corp. I",
    "primary_exchange": "XNAS",
    "announced_date": "2026-07-16",
    "lowest_offer_price": 10.0,
    "highest_offer_price": 10.0,
    "final_issue_price": 10.0,
    "max_shares_offered": 17500000,
    "shares_outstanding": 17500000,
    "total_offer_size": 175000000.0,
    "security_type": "SP",
    "ipo_status": "pending",
    "currency_code": "USD"
  }],
  "status": "OK", "next_url": "…"
}
```

| Vendor field | → Firestore field |
|---|---|
| `ticker`, `issuer_name`, `primary_exchange` | `symbol`, `name`, `exchange` |
| `lowest_offer_price` / `highest_offer_price` | `priceLow` / `priceHigh` |
| `max_shares_offered`, `total_offer_size` | `numberOfShares`, `totalSharesValue` |
| `listing_date` | `date` |
| `ipo_status` | `status` |

⚠️ **No aftermarket price.** This is why the IPOs screen's performance stats (current price, day-1 return) only populate from mock data — neither this nor Finnhub carries it. Join `ohlcv_bars` to fix.

**Free alternative:** Finnhub `/calendar/ipo` ✅ (already the fallback) · SEC S-1/424B filings for the pipeline

---

#### A.1.7 Company news → `news`

**Used by:** `news` job (every 30 min, 09:00–16:00 ET), aggregated concurrently with Finnhub

```http
GET https://api.massive.com/v2/reference/news
      ?ticker=AAPL&published_utc.gte=2026-07-18&published_utc.lte=2026-07-20
      &order=desc&sort=published_utc&limit=10&apiKey=***
```

```jsonc
{
  "results": [{
    "id": "7d6ea2b0a2adc8be71427f32b3c4dade31187b80a9c4c771c07b227e40f2040d",
    "title": "Here's How Much Apple Stock Has to Gain to Overtake Nvidia…",
    "author": "Jennifer Saibil",
    "published_utc": "2026-07-20T10:21:00Z",
    "article_url": "https://www.fool.com/investing/2026/07/20/…",
    "image_url": "https://g.foolcdn.com/image/?url=…",
    "tickers": ["AAPL"],
    "publisher": { "name": "The Motley Fool", "homepage_url": "https://www.fool.com/" },
    "insights": [{ "ticker": "AAPL", "sentiment": "positive", "sentiment_reasoning": "…" }]
  }]
}
```

| Vendor field | → Firestore field |
|---|---|
| `id` | doc id component (`{symbol}_{id}`) |
| `title`, `description` | `headline`, `summary` |
| `publisher.name` | `source` |
| `article_url`, `image_url` | `url`, `imageUrl` |
| `published_utc` | `publishedAt` |
| `insights[].sentiment` / `.sentiment_reasoning` | `sentiment`, `sentimentReasoning` |
| `keywords` | `keywords` |

⚠️ **Known defect:** the job stamps `ticker` with the **queried** symbol rather than reading `tickers[]` from the article — so a story mentioning several companies is attributed only to the one being polled. This now also decides notification recipients.

🆕 **2026-08-16 — Polygon news is now merged with FMP.** `news.job.ts` merges FMP articles (`getStockNews()`, `/stable/news/stock`, via `fmp-news.adapter.ts` / `NEWS_FMP_ADAPTER`, `NEWS_FMP_SOURCE=fmp`) into this feed, deduped by URL (a Polygon collision wins). Every stored article now carries `vendor` (`"polygon"` | `"fmp"`), and the `/live/news` on-demand path writes it too. Polygon articles keep their `sentiment`/`sentimentReasoning`/`keywords`; FMP articles carry a publisher `source` and (frequently null) `sentiment`.

**Free alternative:** Marketaux · GDELT (no key) · publisher RSS. ⚠️ NewsAPI's free tier is **non-commercial only**.

---

#### A.1.8 Options contracts → `options_chains`

**Used by:** `options-chains` job (19:00 ET)

```http
GET https://api.massive.com/v3/reference/options/contracts
      ?underlying_ticker=AAPL&expiration_date.gte=2026-07-20
      &sort=expiration_date&order=asc&limit=20&apiKey=***
```

```jsonc
{
  "results": [{
    "ticker": "O:AAPL260720C00205000",
    "underlying_ticker": "AAPL",
    "contract_type": "call",
    "strike_price": 205,
    "expiration_date": "2026-07-20",
    "exercise_style": "american",
    "shares_per_contract": 100,
    "primary_exchange": "BATO",
    "cfi": "OCASPS"
  }]
}
```

A second call per contract fetches the last bar:
`GET /v2/aggs/ticker/O:AAPL260720C00205000/range/1/day/{from}/{today}?sort=desc&limit=1&apiKey=***`

🆕 **2026-07-22 — this second call now stores the whole bar, not just the close.** Option *contract* aggregates are authorized on Starter, so per-contract market data is real (delayed):

| Vendor field | → Firestore field |
|---|---|
| `o`, `h`, `l`, `c` | `lastOpen`, `lastHigh`, `lastLow`, `lastClose` |
| `vw` | `lastVwap` |
| `v`, `n` | `lastVolume`, `lastTradeCount` |
| computed | `lastRangePct` — the contract's own traded intraday range |

`lastRangePct` is the traded high-low range on the contract's last session. It is **not** a substitute for a bid-ask spread and must not be presented as one.

🔴 **Still not available on this plan (probed 2026-07-22, returns `NOT_AUTHORIZED`):** bid/ask, implied volatility, greeks, open interest — these need the Options add-on or Tradier. The stored doc carries this note verbatim. This remains the gap the Options screen fills with `buildChain()` fabrication.

**Free alternative:** **Tradier** (`TRADIER_ACCESS_TOKEN` already provisioned, unwired — sandbox returns delayed chains *with* greeks and OI) · CBOE delayed quotes · Alpaca options

---

#### A.1.9 Financials → `companies` (merge) · 🆕 `financials`

**Used by:** `fundamentals-growth` job (04:30 ET) · 🆕 `financials` job (04:45 ET) · company-profile EPS derivation

```http
GET https://api.massive.com/vX/reference/financials
      ?ticker=AAPL&timeframe=annual&limit=2&apiKey=***
```

Response shape (per `results[]`): `fiscal_year`, then
`financials.income_statement.{revenues, cost_of_revenue, gross_profit, diluted_earnings_per_share}.value`

| Derived | Formula |
|---|---|
| `revenueGrowthYoY` | `(rev[0] − rev[1]) / rev[1]` |
| `epsGrowthYoY` | `(eps[0] − eps[1]) / eps[1]` |
| `grossMargin` | `gross_profit / revenues` |

🆕 **2026-07-22 — the balance sheet and cash flow were already in this payload and were being thrown away.** `financials.job.ts` (NEW, 04:45 ET) now reads the full statement set and writes `financials/{ticker}` with a per-quarter array. The Stock and Earnings screens previously drew these charts from `earnIncome()`, which invented ratios.

Additional response paths now read, per `results[]`:
`financials.balance_sheet.*`, `financials.cash_flow_statement.*`

| Vendor field | → Firestore field |
|---|---|
| `balance_sheet.assets` | `totalAssets` |
| `balance_sheet.liabilities`, `.equity` | `totalLiabilities`, `totalEquity` |
| `balance_sheet.current_assets`, `.current_liabilities` | `currentAssets`, `currentLiabilities` |
| `cash_flow_statement.net_cash_flow` | `netCashFlow` |
| `…net_cash_flow_from_operating_activities` | `operatingCashFlow` |
| `…net_cash_flow_from_investing_activities` | `investingCashFlow` |
| `…net_cash_flow_from_financing_activities` | `financingCashFlow` |
| derived | `grossMarginPct`, `operatingMarginPct`, `netMarginPct`, `currentRatio` |

**Note:** margins guard on `revenue > 0` rather than merely non-null — a quarter reporting zero revenue would otherwise divide to `Infinity` and render as a real margin.

🔴 **`/vX/` is still Polygon's EXPERIMENTAL namespace, and this revision increases the app's dependence on it.** Code comment verbatim: *"The replacement (/stocks/financials/v1/*) needs Advanced or the Financials add-on, so this path cannot be upgraded on Starter and may break without deprecation notice."* Tagged `STALE_DATA`. Wiring more screens to it makes the SEC XBRL migration **more** urgent, not less.

**Free alternative:** **SEC XBRL `companyconcept` / `frames` — free, no key, authoritative, and immune to vendor deprecation.** Strongly recommended migration. Also Alpha Vantage `INCOME_STATEMENT`.

---

#### 🆕 A.1.10 Related companies (peers) → `companies.peers[]`

**Used by:** `companies` job via `polygon-company-profile.adapter.ts`

```http
GET https://api.massive.com/v1/related-companies?ticker=AAPL&apiKey=***
```

```jsonc
{ "ticker": "AAPL", "results": [{ "ticker": "MSFT" }, { "ticker": "GOOGL" }, …], "status": "OK" }
```

→ `peers: string[]`. **Authorized on Starter** — the previous `FIELD_NOT_SUPPORTED` flag was incorrect.

This replaces the Stock screen's peer list, which was a sector-filtered mock whose "change" column was computed as `(rsRating − 50) / 10` — a rating rescaled into a percentage sign, not a price move.

**Free alternative:** FMP `/stable/stock-peers` ✅ (already called) · derive from `companies.sector` + market cap band

---

#### 🆕 A.1.11 Dividend history & splits → `dividend_history`, `splits`

**Used by:** `corporate-actions` job (06:40 ET) — **NEW**. Distinct from A.1.5, which syncs the forward-looking *calendar*; this syncs the full **payment history** per ticker.

```http
GET https://api.massive.com/v3/reference/dividends?ticker=AAPL&limit=1000&apiKey=***
GET https://api.massive.com/v3/reference/splits?ticker=AAPL&limit=1000&apiKey=***
```

`dividend_history/{ticker}` — one doc per ticker:

| Field | Meaning |
|---|---|
| `payments[]` | every historical payment (`exDate`, `payDate`, `amount`, `frequency`, `type`) |
| `byYear[]` | annual totals and payment counts |
| `ttmTotal` | trailing-twelve-month dividend total |
| `yieldPct` | derived — `ttmTotal ÷ current close` (close read from `companies`) |
| `cagr5y` | 5-year dividend growth rate |
| `increaseStreak` | consecutive years of increase |

`splits/{ticker}` — `executionDate`, `splitFrom`, `splitTo`.

**This replaces two separate fabrications:** the Stock screen's dividend card/drawer (a 10-year series extrapolated backwards at a fixed 6.5 %/yr, with ex-dividend dates derived from `symbol.charCodeAt(0)`) and Macro's `divHistory()` decay curve.

⚠️ **`yieldPct` is derived here, not vendor-supplied.** It is only as fresh as the `companies` close it divides by. FMP still supplies a vendor `yield` on the calendar path (A.2.7).

**Free alternative:** Finnhub `/stock/dividend` · Nasdaq dividend history · SEC filings

---

#### 🆕 A.1.12 Treasury yields → `market_indices/US10Y`

**Used by:** `market-indices` job (18:05 ET)

```http
GET https://api.massive.com/fed/v1/treasury-yields?limit=1&sort=date.desc&apiKey=***
```

→ `market_indices/US10Y` with `value` = the **actual 10-year yield**, `isProxy: false`, `unit: "percent"`.

🔴 **This corrects a sign error, not merely a data gap.** The US10Y tile previously showed the **TLT ETF** — a long-duration Treasury *bond fund*, which moves **inversely** to the yield it was labelled as. A day when yields rose showed the tile falling. Every other index tile in `market_indices` remains an **ETF proxy** with `isProxy: true` (SPY, QQQ, DIA, IWM, VIXY …), because index *values* (`I:SPX`, `I:VIX`) return 403 on this plan.

**Free alternative:** FRED series `DGS10` ✅ — free, authoritative, and FRED is **already wired** for macro (A.4). Arguably the better source.

---

#### 🆕 A.1.13 Market status & holidays → `GET /live/market-status`

**Used by:** `src/live/market-status.service.ts` (NEW) → backend endpoint `GET /live/market-status`

```http
GET https://api.massive.com/v1/marketstatus/now?apiKey=***
GET https://api.massive.com/v1/marketstatus/upcoming?apiKey=***
```

Returns the exchange's own session state (`market`, `earlyHours`, `afterHours`, per-exchange status) and the upcoming holiday calendar.

⚠️ **Works locally only.** The browser reaches this through `NEXT_PUBLIC_BACKEND_URL`, which is unset in the production build — see §D.4 gap 1. In production the shell's market-status pill falls back to `getMarketStatus()`, a **local** ET computation (`Intl.DateTimeFormat` with `America/New_York`, DST-aware, against a hardcoded holiday table through 2027). That local path is correct as written, but it is not an exchange feed and will drift on an unscheduled halt or an early close not in the table.

---

#### 🆕 A.1.14 Universal snapshot → snapshot cache (v3)

**Used by:** `src/live/snapshot-cache.service.ts`, bumped v2 → **v3**

```http
GET https://api.massive.com/v3/snapshot?ticker.any_of=AAPL,MSFT&apiKey=***
```

Adds to the cached quote shape:

| Field | Meaning |
|---|---|
| `earlyTradingChangePct` | pre-market move |
| `lateTradingChangePct` | after-hours move |
| `regularTradingChangePct` | regular-session move, separated from the blended figure |
| `marketStatus` | vendor's session label for the quote |

⚠️ **Also production-blocked.** These fields reach the UI through the backend (`useExtendedHours`), so the Commentary screen's Before-the-Bell / After-the-Close move numbers are real **on localhost only**. See §D.4 gap 1.

---

### A.2 FMP (Financial Modeling Prep)

| | |
|---|---|
| **Base URL** | `https://financialmodelingprep.com/stable` — **hardcoded**, no env override |
| **Auth** | `?apikey=***` |

---

#### A.2.1 Earnings calendar → `earnings_events`

**Used by:** `earnings` job (06:00 ET) — injected directly, no adapter, no fallback

```http
GET https://financialmodelingprep.com/stable/earnings-calendar
      ?from=2026-07-20&to=2026-07-24&apikey=***
```

```jsonc
[{
  "symbol": "HCA",
  "date": "2026-07-24",
  "epsActual": null,
  "epsEstimated": 7.52,
  "revenueActual": null,
  "revenueEstimated": 19675520000,
  "lastUpdated": "2026-07-20"
}]
```

| Vendor field | → Firestore field |
|---|---|
| `symbol`, `date` | `ticker`, `date` (also doc id `{symbol}_{date}`) |
| `epsEstimated`, `epsActual` | `epsEstimate`, `epsActual` |
| `revenueEstimated`, `revenueActual` | `revenueEstimate`, `revenueActual` |

🔴 **Two hard limitations, both measured live on 2026-07-20:**
1. **Coverage: 10 rows for Jul 20–24.** `limit=1000` changes nothing; a single day returned 2 rows. Finnhub returns **488** for the same window.
2. **No session field.** The seven fields above are the entire response — Before Open / After Close cannot be sourced here at all.

🆕 **2026-08-16 — full-US coverage.** The forward calendar no longer filters to the ~385 tracked `companies`. `earnings.job.ts`'s `loadRefNames` resolves every FMP calendar symbol against the ~13,106-row Polygon US ticker reference (`tickers`, written by `ticker-universe.job`), keeping US CS/ADRC listings (with Polygon names) and dropping FMP's worldwide rows. Reported/historical rows were already full-US via Polygon `getFinancialsByFilingDate`. Aug 26 2026 went 4 → 38 reporters; `earnings_events` ~7.3k → ~8.8k. NOTE: `/market-data/earnings` still returns the whole collection to the client — date-window it if it grows large.

**Free alternative:** **Finnhub `/calendar/earnings` ✅ — 488 rows + `hour` (bmo/amc) + `quarter`/`year`, on the key you already hold.** See §C.3.

---

#### A.2.2 Company profile → `companies`

```http
GET https://financialmodelingprep.com/stable/profile?symbol=AAPL&apikey=***
```

```jsonc
[{
  "symbol": "AAPL", "companyName": "Apple Inc.",
  "price": 333.74, "change": 0.48, "changePercentage": 0.14403,
  "marketCap": 4901758191440, "beta": 1.097,
  "volume": 63407059, "averageVolume": 54830800,
  "range": "201.5-334.99",
  "exchange": "NASDAQ", "exchangeFullName": "NASDAQ Global Select",
  "industry": "Consumer Electronics", "sector": "Technology",
  "cik": "0000320193", "isin": "US0378331005", "cusip": "037833100",
  "lastDividend": 1.05, "website": "https://www.apple.com",
  "description": "Apple Inc. is a global technology corporation…"
}]
```

| Vendor field | → Firestore field |
|---|---|
| `companyName` | `name` |
| `changePercentage` | `pctChange` |
| `range` | `week52Range` |
| `averageVolume` | `averageVolume` |
| `price`, `marketCap`, `beta`, `sector`, `industry`, `exchange`, `volume`, `description` | same |

**Note:** FMP gives a real `sector` taxonomy; Polygon only gives SIC codes. That is why FMP is preferred for enrichment despite Polygon being primary.

---

#### A.2.3 Valuation ratios → `companies`

```http
GET https://financialmodelingprep.com/stable/ratios-ttm?symbol=AAPL&apikey=***
```

Returns ~40 TTM ratio fields. Only four are read:

```jsonc
[{
  "symbol": "AAPL",
  "priceToEarningsRatioTTM": …,
  "netIncomePerShareTTM": …,
  "dividendYieldTTM": …,
  "dividendPerShareTTM": …,
  "grossProfitMarginTTM": 0.4786,   // present but unused
  "netProfitMarginTTM": 0.2715      // present but unused
}]
```

→ `peRatio`, `eps`, `dividendYield`, `dividendPerShare`

⚠️ Failures here are logged as *"likely this plan's undocumented per-symbol restriction, not a genuine absence of data"* (`SUB_REQUEST_FAILED`).

---

#### A.2.4 Analyst consensus → `analyst_actions`

```http
GET https://financialmodelingprep.com/stable/grades-consensus?symbol=AAPL&apikey=***
```

```jsonc
[{ "symbol": "AAPL", "strongBuy": 1, "buy": 70, "hold": 32, "sell": 8, "strongSell": 0, "consensus": "Buy" }]
```

→ written verbatim, plus `source: 'fmp_consensus_interim'`

⚠️ **A single snapshot with no history and no per-firm detail** — no firm name, no action type, no price target, no date. The Analyst screen's per-firm table is therefore entirely static mock data.

**Free alternative:** **Finnhub `/stock/recommendation` ✅ — same vote buckets but as a monthly time series**, enabling real trend display.

---

#### A.2.5 Market movers → `market_movers`

```http
GET https://financialmodelingprep.com/stable/biggest-gainers?apikey=***
GET https://financialmodelingprep.com/stable/biggest-losers?apikey=***
```

```jsonc
[{
  "symbol": "PRPL", "name": "Purple Innovation, Inc.",
  "price": 7.2425, "change": 6.9324,
  "changesPercentage": 2235.53691,
  "exchange": "NASDAQ"
}]
```

⚠️ **Two issues visible in this single captured row:**
1. **No `volume` field** — this source cannot apply a minimum-volume filter; `volume` is written as `0` (`FIELD_NOT_SUPPORTED`).
2. `changesPercentage: 2235%` is almost certainly a reverse-split artifact, not a real move. With no volume filter available, corporate-action noise reaches the Movers screen unfiltered.

**Free alternative:** Polygon grouped-daily ✅ (already the fallback) — **has volume**, so it can filter properly. Consider making Polygon primary here.

---

#### A.2.6 Sector performance → `sectors`

```http
GET https://financialmodelingprep.com/stable/sector-performance-snapshot?date=2026-07-17&apikey=***
```

```jsonc
[{ "date": "2026-07-17", "sector": "Basic Materials", "exchange": "NASDAQ", "averageChange": -1.3644 }]
```

→ `sector`, `exchange`, `pctChange`, `asOfDate`. Walks back up to 5 candidate trading days when a date returns empty (holidays).

**Note:** this is the *fallback*. The primary path derives sectors from 11 SPDR ETF quotes because **Polygon has no sector endpoint on any tier** — so the primary is arguably the weaker source here.

---

#### A.2.7 Dividends calendar → `dividends` (fallback)

```http
GET https://financialmodelingprep.com/stable/dividends-calendar?from=2026-07-01&to=2026-08-01&apikey=***
```

Fields read: `symbol, date, recordDate, paymentDate, declarationDate, dividend, yield, frequency` — already camelCase, mapped near-directly. **Includes `yield`, which Polygon lacks.**

---

#### A.2.8 Stock peers → `companies`

```http
GET https://financialmodelingprep.com/stable/stock-peers?symbol=AAPL&apikey=***
```

Returns an array of `{ symbol }` → `peers[]`.

---

### A.3 Finnhub

| | |
|---|---|
| **Base URL** | `https://finnhub.io/api/v1` — hardcoded |
| **Auth** | `?token=***` |
| **Currently used for** | news (aggregated with Polygon), IPO fallback, quote fallback |

---

#### A.3.1 Quote → `market_indices` (fallback)

```http
GET https://finnhub.io/api/v1/quote?symbol=AAPL&token=***
```

```jsonc
{
  "c": 333.74,      // current
  "d": 0.48,        // change
  "dp": 0.144,      // change %
  "h": 334.99,      // high
  "l": 329.0006,    // low
  "o": 331.98,      // open
  "pc": 333.26,     // prev close
  "t": 1784318400   // epoch seconds
}
```

**This shape *is* the canonical `CanonicalQuote`** — the adapter layer was modelled on it, so mapping is 1:1. A zero `c` is treated as "no quote" rather than a real price of $0.

---

#### A.3.2 Company news → `news`

```http
GET https://finnhub.io/api/v1/company-news?symbol=AAPL&from=2026-07-18&to=2026-07-20&token=***
```

```jsonc
[{
  "id": 140958639,
  "category": "company",
  "datetime": 1784544060,
  "headline": "Here's How Much Apple Stock Has to Gain to Overtake Nvidia…",
  "summary": "Apple is likely to reclaim the lead again…",
  "source": "Yahoo",
  "related": "AAPL",
  "image": "https://s.yimg.com/rz/stage/p/yahoo_finance_en-US_h_p_finance_2.png",
  "url": "https://finnhub.io/api/news?id=85c89d49…"
}]
```

| Vendor field | → Firestore field |
|---|---|
| `headline`, `summary`, `source`, `url`, `category` | same names |
| `datetime` (unix **seconds**) | `publishedAt` (→ ISO) |
| `image` | `imageUrl` |

⚠️ **No sentiment or keyword fields** — structurally null on this source, not a transient failure (`FIELD_NOT_SUPPORTED`).

---

#### A.3.3 IPO calendar → `ipos` (fallback)

```http
GET https://finnhub.io/api/v1/calendar/ipo?from=2026-07-01&to=2026-08-01&token=***
```

Response: `{ "ipoCalendar": [{ date, symbol, name, exchange, price, numberOfShares, totalSharesValue, status }] }`

---

#### A.3.4 ⭐ Earnings calendar — **available but NOT wired**

```http
GET https://finnhub.io/api/v1/calendar/earnings?from=2026-07-20&to=2026-07-24&token=***
```

```jsonc
{
  "earningsCalendar": [{
    "symbol": "ABR",
    "date": "2026-07-24",
    "hour": "",              // "bmo" | "amc" | "dmh" | ""
    "quarter": 2,
    "year": 2026,
    "epsEstimate": 0.0545,
    "epsActual": null,
    "revenueEstimate": 50702000,
    "revenueActual": null
  }]
}
```

**Live probe, 2026-07-20, same date window as FMP:**

| | FMP (in use) | Finnhub (available) |
|---|---|---|
| Rows Jul 20–24 | **10** | **488** |
| `hour` (session) | absent | `bmo`=138, `amc`=169, blank=181 |
| `quarter` / `year` | absent | present |

**This is the single highest-value change available** — see §C.3. Caveat: ~37% of rows have blank `hour`; the UI must render that as "unspecified", never default it to a session.

---

#### A.3.5 ⭐ Analyst recommendation trends — **available but NOT wired**

```http
GET https://finnhub.io/api/v1/stock/recommendation?symbol=AAPL&token=***
```

```jsonc
[
  { "symbol": "AAPL", "period": "2026-07-01", "strongBuy": 13, "buy": 23, "hold": 16, "sell": 2, "strongSell": 0 },
  { "symbol": "AAPL", "period": "2026-06-01", "strongBuy": 14, "buy": 24, "hold": 15, "sell": 2, "strongSell": 0 },
  { "symbol": "AAPL", "period": "2026-05-01", "strongBuy": 15, "buy": 24, "hold": 13, "sell": 2, "strongSell": 0 }
]
```

A **monthly time series** where FMP gives one snapshot — enough to render a real ratings trend on the Analyst screen.

---

### A.4 FRED (St. Louis Fed) — macro

| | |
|---|---|
| **Base URL** | `https://api.stlouisfed.org/fred` — hardcoded · **Auth:** `?api_key=***` |

```http
GET https://api.stlouisfed.org/fred/series/observations
      ?series_id=CPIAUCSL&api_key=***&file_type=json&sort_order=desc&limit=2
```

```jsonc
{
  "realtime_start": "2026-07-14", "realtime_end": "2026-07-14",
  "units": "lin", "count": 954, "offset": 0, "limit": 2,
  "observations": [
    { "realtime_start": "2026-07-14", "realtime_end": "2026-07-14",
      "date": "2026-06-01", "value": "332.568" }
  ]
}
```

| Vendor field | → Firestore field |
|---|---|
| `observations[0].date` | `eventDate` |
| `observations[0].value` | `actual` (string; `"."` sentinel → `null`) |
| `observations[1].value` | `previous` |
| — | `estimate` — **always `null`**; FRED has no consensus concept |

✅ **Free, authoritative, no rate concern. Already the right choice — no alternative needed.**

---

### A.5 SEC EDGAR — insider & institutional

| | |
|---|---|
| **Base URLs** | `https://data.sec.gov/submissions` · `https://www.sec.gov/Archives/edgar/data` — hardcoded |
| **Auth** | None. Requires a `User-Agent` identifying the caller (SEC policy) — env `SEC_EDGAR_USER_AGENT`. Throttled ≥150 ms between requests. |

```http
GET https://data.sec.gov/submissions/CIK0000320193.json
User-Agent: Market Catalyst Backend hello@inc108.com
```

Response: `filings.recent.{form[], filingDate[], accessionNumber[], primaryDocument[]}` — **parallel arrays**, filtered for `form === "13F-HR"` or `"4"`.

Then, per filing:
```http
GET https://www.sec.gov/Archives/edgar/data/320193/{accessionNoDashes}/index.json   → locate the XML
GET https://www.sec.gov/Archives/edgar/data/320193/{accessionNoDashes}/{infoTable}.xml
```

| Filing | XML path read | → Firestore |
|---|---|---|
| 13F-HR | `informationTable.infoTable[].{cusip, nameOfIssuer, value, shrsOrPrnAmt.sshPrnamt}` | `fund_holdings/{cik}/filings/{accession}/positions/{cusip}` (top 200 by value) |
| Form 4 | `ownershipDocument.{issuer.*, reportingOwner.*, nonDerivativeTable.nonDerivativeTransaction[].*}` | `insider_transactions/{accession}_{index}` |

⚠️ **Code-quality issue:** `https://www.sec.gov/files/company_tickers.json` (the ticker→CIK map) is fetched by a **raw `fetch()` inside `sec-form4.job.ts` itself**, bypassing both `SecEdgarService` and `fetchJson()` — so it has no retry/backoff and no URL redaction on error.

✅ **Free and authoritative. Already the right choice.**

---

### A.6 Adapter fallback chains

Configured per domain via `<NAME>_SOURCE` / `<NAME>_FALLBACK_SOURCE`.

| Adapter token | Chain (`.env.example`) |
|---|---|
| `COMPANY_PROFILE_ADAPTER` | polygon → fmp |
| `MOVERS_ADAPTER` | fmp → polygon |
| `MOVER_ENRICHMENT_ADAPTER` | polygon → fmp |
| `NEWS_ADAPTER` | **aggregate** — polygon + finnhub called **concurrently**, merged, deduped by URL/headline |
| `NEWS_FMP_ADAPTER` 🆕 | **aggregate (2026-08-16)** — FMP articles (`NEWS_FMP_SOURCE=fmp`, `/stable/news/stock`) merged into the feed, deduped by URL (Polygon wins); every article carries a `vendor` field (`polygon`\|`fmp`) |
| `DIVIDENDS_ADAPTER` | polygon → fmp |
| `IPOS_ADAPTER` | polygon → finnhub |
| `SECTORS_ADAPTER` | polygon → fmp |
| `QUOTE_ADAPTER` | polygon → finnhub |
| `MARKET_BARS_ADAPTER` | polygon only |
| `TICKER_UNIVERSE_ADAPTER` | polygon only |
| `FINANCIALS_ADAPTER` | polygon only |

⚠️ Code defaults differ from `.env.example` for `COMPANY_PROFILE` and `MOVERS` (reversed). Production values live in Cloud Run / Secret Manager and are **not knowable from this repo**.

**Not behind adapters** (single-vendor, no fallback): FMP for earnings + analyst-actions · Polygon for fear-greed, market-quotes, options-chains · FRED for macro · SEC EDGAR for 13F/Form 4.

---

### A.7 Sync job → collection map

| Job | Cron (ET) | Writes | Vendor |
|---|---|---|---|
| `ticker-universe` | `0 3 * * 0` | `tickers` | Polygon |
| `market-quotes` | `7 18 * * 1-5` | `tickers` (merge) | Polygon |
| `companies` | `0 2 * * *` | `companies` | Polygon → FMP 🆕 now incl. `peers`, `dividendYield`, `dividendPerShare` |
| `stock-history` | `0 3 * * *` | `ohlcv_bars` | Polygon 🆕 **5-year** backfill (was 300 days) + `vwap` per bar |
| 🆕 `intraday-bars` | `25 16 * * 1-5` | `intraday_bars` | Polygon (5-min + 30-min aggs) |
| `rs-rating` | `0 4 * * *` | `companies` (merge) | **none — computed from `ohlcv_bars`** 🆕 now also persists raw `rsScore` (2026-08-16) so a single on-demand ticker can be ranked against the stored distribution |
| `technical-indicators` | `10 4 * * *` | `companies` (merge) | **none — computed** 🆕 +`rsi14Series`, `smaLadder`, `emaLadder`, `vwap`, `high52`/`low52`, `avgVolume20/50` |
| `tech-rating` | `15 4 * * *` | `companies` (merge) | **none — computed** 🆕 now also persists raw `techMomentum`/`techTrend`/`techRsi` (2026-08-16) for on-demand ranking |
| `fundamentals-growth` | `30 4 * * *` | `companies` (merge) | Polygon (experimental `/vX/`) |
| 🆕 `financials` | `45 4 * * *` | `financials` | Polygon (experimental `/vX/`) — balance sheet, cash flow, margins |
| `market-indices` | `5 18 * * 1-5` | `market_indices`, `market_indices_history` | Polygon → Finnhub 🆕 US10Y from `/fed/v1/treasury-yields`, no longer the TLT proxy |
| `market-movers` | `0 18 * * 1-5` | `market_movers`, `market_movers_history` | FMP → Polygon |
| `sectors` | `0 18 * * 1-5` | `sectors`, `sectors_history` | Polygon (ETF proxy) → FMP |
| `news` | `*/30 9-16 * * 1-5` | `news` (+ per-user notifications) | Polygon 🆕 **+ FMP** (2026-08-16; `NEWS_SOURCE=polygon`, `NEWS_FMP_SOURCE=fmp`; every article carries `vendor`. Finnhub is NOT in the feed — unlicensed for redistribution) |
| `earnings` | `0 6 * * *` | `earnings_events` | FMP 🆕 **full-US** — forward symbols resolved against Polygon `tickers` ref (not just the ~385 tracked `companies`) |
| `analyst-actions` | `0 6 * * *` | `analyst_actions` | FMP |
| `dividends` | `20 6 * * *` | `dividends` (forward calendar) | Polygon → FMP |
| 🆕 `corporate-actions` | `40 6 * * *` | `dividend_history`, `splits` | Polygon (full payment history + splits) |
| `ipos` | `15 6 * * *` | `ipos` | Polygon → Finnhub |
| `macro-events` | `10 18 * * 1-5` | `macro_events` | FRED |
| `fear-greed` | `15 18 * * 1-5` | `market_sentiment` | Polygon (computed) |
| 🆕 `market-breadth` | `30 18 * * 1-5` | `market_breadth` | Polygon grouped-daily (computed) |
| `options-chains` | `0 19 * * 1-5` | `options_chains` | Polygon 🆕 per-contract OHLC/VWAP/trade count |
| `sec-13f` | `0 1 * * *` | `fund_holdings/**` | SEC EDGAR |
| `sec-form4` | `30 1 * * *` | `insider_transactions` | SEC EDGAR |

🔴 **These crons have never fired in production.** No Cloud Scheduler jobs exist in any region and there is no `scheduler-invoker` service account — `create-scheduler-jobs.sh` was never run. With Cloud Run `min-instances=0` the in-process `@Cron` decorators never execute. **All data currently in Firestore came from manual job runs.** The cron column above describes intent, not observed behaviour. See §D.4 gap 2.

---

# Part B — Screen-by-screen, feature-by-feature

**One section per screen. One row per feature.** Every row carries its own type, source, provider, endpoint and alternative — nothing is deferred to another part of this document.

Column meanings:
- **Type** — API (live vendor data) · STATIC (hardcoded) · GENERATED (fabricated in-browser) · HYBRID (live overlaid on static) · USER (user-entered) · NONE (pure UI) · FAKE (simulates an action it does not perform)
- **Source** — the Firestore collection, const, or function actually supplying the value
- **Endpoint** — the vendor call behind it. `—` where no API is involved
- **Free alternative** — for API rows: another vendor for the same data. **For STATIC/GENERATED rows: what you would wire to make it real.** ⚠️ unverified unless marked ✅

---

## B.1 Dashboard — `app/iq/screens/dashboard.tsx` · **17 features**

Mission-control landing screen: summary cards, hover popovers, slide-in drawers.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Market Pulse strip | HYBRID | `market_indices` over static `pulse` | Polygon → Finnhub | `/v2/aggs/ticker/{ticker}/range/1/day/…` | Finnhub `/quote` ✅ (already wired) · Twelve Data |
| 2 | "What Matters Now" AI feed | STATIC | `wmn` array | — | — | Anthropic API (`ANTHROPIC_API_KEY` already provisioned, unused) |
| 3 | 30-sec audio button | NONE | no handler | — | — | Any TTS (ElevenLabs, Google TTS) |
| 4 | Earnings Today | HYBRID | `earnings_events` (EPS only) | FMP | `/stable/earnings-calendar` | **Finnhub `/calendar/earnings` ✅ 488 vs 10 rows** |
| 5 | Movers card (3 tabs) | HYBRID | `market_movers` | FMP → Polygon | `/stable/biggest-gainers`, `/losers` | Polygon grouped-daily ✅ (already the fallback) |
| 6 | Heatmap mini-grid | HYBRID | `companies` + `sectors` | Polygon | `/v3/reference/tickers/{ticker}` | FMP `/sector-performance-snapshot` ✅ |
| 7 | Analyst Actions 🆕 | HYBRID | static `analyst` + live consensus pill; **popup now shows price-target median/low-high + recent grades** (2026-08-16, was a stale "not built yet" note) | FMP | `/stable/grades-consensus` | **Finnhub `/stock/recommendation` ✅ (adds history)** |
| 8 | Screener leaders/laggards | STATIC | `screenerStocks` | — | — | Derive from `companies` (already synced) |
| 9 | Portfolio Pulse | HYBRID/USER | `users/{uid}/portfolios/default/holdings` | — | — | — (user data; prices from `companies`) |
| 10 | Watchlist card | HYBRID/USER | `users/{uid}/watchlists/default` | — | — | — |
| 11 | Insider & Institutional | HYBRID | `insider_transactions` + `INSIDER_MINI_MOCK` | SEC EDGAR | `/submissions/CIK{10-digit-CIK}.json` | — already optimal (free, authoritative) |
| 12 | Live Market Feed 🆕 | HYBRID | `news`, falls back `MOCK_LIVE_FEED`; **each doc carries `vendor` (`polygon`\|`fmp`), publisher `source`, `sentiment`, thumbnail** (2026-08-16) | Polygon + FMP | `/v2/reference/news`, `/stable/news/stock` | Marketaux · GDELT · publisher RSS |
| 13 | Recaps card | GENERATED | one-line `.txt` blob labeled "PDF" | — | — | Anthropic API + a real PDF lib |
| 14 | VIX card | HYBRID | `market_indices` VIX; falls back `14.18` | Polygon | `/v2/aggs/ticker/VIXY/…` | CBOE delayed · Finnhub `/quote` |
| 15 | Fear & Greed gauge 🆕 | **LIVE**→fallback | `market_sentiment/fear_greed`; falls back `62` | Polygon (computed) | grouped-daily | CNN unofficial endpoint (keep in-house) |
| 16 | Hover popups 🆕 | — | derived from rows above; **mover popup null-guards RVOL/RS** (2026-08-16 — renders `NotAvailable` instead of a fabricated "0×"/"0/99") | — | — | — |
| 17 | Market Internals + F&G History drawers | STATIC | `MARKET_INTERNALS`, `FG_HISTORY` | — | — | 🆕 `market_breadth` now synced (18:30 ET) — wire it |

🆕 **#15 — the gauge was silently showing a hardcoded number, and the cause was a Firestore rule, not the frontend.** `market_sentiment` had **no rule at all** in the deployed ruleset, so default-deny blocked every read; the component's `?? 62` fallback then rendered a permanent **62 / "Greed"** with no error surfaced to the user. The `fear-greed` job had been writing real values the whole time. A rule for `market_sentiment` was added (the same fix also restored `stock_comments`, which powers chart notes — B.2 #7). The `?? 62` fallback is still in the code, so this is **LIVE→fallback**, not unconditionally LIVE: if the job has not run, the gauge silently reverts to 62 exactly as before.

⚠️ This is worth generalising: a **silent literal fallback behind a permission error** is indistinguishable from real data in the UI. Rows tagged LIVE→fallback throughout Part B share that failure mode.

---

## B.2 Stock Detail — `app/iq/screens/stock.tsx` · **18 features**

Full single-stock page: chart, ratings, financials, peers, dividends, notes.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Symbol search + watchlist star | STATIC/USER | `SYMBOLS`; star → **`localStorage`** | — | — | Migrate star to Firestore |
| 2 | Header price/name/sector | HYBRID | `companies` | Polygon → FMP | `/v3/reference/tickers/{ticker}` | Finnhub `/stock/profile2` |
| 3 | Price chart 🆕 | **LIVE** | `useChartBars` — **all 7 timeframes**: 1D/1W ← `intraday_bars/{sym}_5min`, 1M ← `_30min`, 3M–5Y ← `ohlcv_bars` | Polygon | `/v2/aggs/…/range/{5\|30}/minute/…`, `/range/1/day/…` | Stooq (free CSV) · Tiingo · Twelve Data |
| 4 | RSI pane 🆕 | **LIVE** | `RsiPane series={company.rsi14Series}` — 90-point rolling RSI(14) | computed from `ohlcv_bars` | — | — (already computed) |
| 5 | EPS surprise pane (`EarnPane`) | GENERATED | `earnHistory()` hash — **still synthetic**, this pane was not rewired | — | — | Finnhub `/calendar/earnings` ✅ history |
| 6 | Chart pattern callout | GENERATED | canned phrase on `isUp` | — | — | Anthropic API |
| 7 | Chart notes 🆕 | USER | `stock_comments` — **was silently blocked**, no Firestore rule existed | — | — | — |
| 8 | Keystats grid 🆕 | **LIVE→fallback** | `companies.high52`/`low52`/`avgVolume20`/`vwap`; **Short Int. still static** | Polygon | `/v3/reference/tickers/{ticker}` + computed | FINRA short-interest files (free) |
| 9 | AI Technical Analysis | GENERATED | template string | — | — | Anthropic API |
| 10 | Financials chart 🆕 | **LIVE→fallback** | `useFinancials` → `financials/{ticker}` — real income statement, balance sheet, cash flow; falls back to `earnIncome()` when `hasData` is false | Polygon | `/vX/reference/financials` | **SEC XBRL `companyconcept` — still recommended, `/vX/` is experimental** |
| 11 | Earnings Growth chart 🆕 | **LIVE→fallback** | `histEps` ← `fin.epsHistory`; falls back to `earnHistory()` | Polygon + FMP | `/vX/reference/financials` ⋈ `earnings_events` | SEC XBRL · Finnhub |
| 12 | Technical Rating 🆕 | **LIVE→fallback** | `companies.rsi14/macd` + `smaLadder`/`emaLadder`; **MA counts now real** | computed in-house | — | — |
| 13 | Peers list 🆕 | **LIVE→fallback** | `companies.peers[]`; falls back to the old sector filter for untracked tickers | Polygon | `/v1/related-companies` | FMP `/stable/stock-peers` ✅ |
| 14 | Industry Group rank | STATIC | `sectorList` | — | — | Derive from `companies.sector` |
| 15 | Dividend card + history drawer 🆕 | **LIVE→fallback** | `useDividendHistory` → `dividend_history/{ticker}` (real ex/pay dates, TTM, yield, CAGR, streak) | Polygon | `/v3/reference/dividends` | Finnhub `/stock/dividend` |
| 16 | Earnings history 🆕 | **LIVE→fallback** | `hist10` ← `fin.epsHistory` (real actual vs estimate); falls back to `earnHistory()`. ⚠️ price-reaction column is **0**, and the caption still reads "illustrative" | Polygon + FMP | `/vX/reference/financials` ⋈ `earnings_events` | Finnhub `/calendar/earnings` ✅ |
| 17 | Insider & institutional | HYBRID | `insider_transactions`; ownership % still static | SEC EDGAR | `/submissions/CIK{10-digit-CIK}.json` | Derive ownership from `fund_holdings` (already synced) |
| 18 | Key levels (pivots) | GENERATED | fixed multiples `p*1.03` | — | — | Compute from `ohlcv_bars` high/low |

### 🆕 What each of these was before (2026-07-22)

The Stock screen carried the highest concentration of fabrication in the app. For the record — and so that nobody "re-fixes" something already fixed, or assumes a neighbouring row was fixed too:

| Row | Was | Now |
|---|---|---|
| #3 chart, 1D/1W/1M | `genOHLC()` seeded random walk | `intraday_bars` 5-min / 30-min aggregates |
| #3 chart, 5Y | `genOHLC()` — daily bars only went back 300 days | 5-year `ohlcv_bars` backfill |
| #4 RSI pane | sine wave + seeded random walk, **rendered beside a real RSI(14) number** | `companies.rsi14Series` |
| #8 VWAP row | `p × 0.994` | real vendor `vw` on the latest bar |
| #8 52-week high/low | `p × 0.58` / `p × 1.02` — **fixed multiples of the *current* price**, so the "52-week range" tracked today's quote | `companies.high52` / `low52` from a real 252-bar window |
| #8 Avg volume | `marketCap ÷ price × constant` | `companies.avgVolume20` |
| #12 MA / EMA drawer rows | price multiples (`p × 0.906`, …) | `companies.smaLadder` / `emaLadder` (10/20/30/50/100/200) |
| #13 Peers | sector-filtered mock; change column = `(rsRating − 50) / 10` | `/v1/related-companies` |
| #15 Dividends | 10-year series extrapolated at a **fixed 6.5 %/yr**; ex-dividend dates from `symbol.charCodeAt(0)` | `dividend_history` — actual payments, dates and amounts |
| #15 Dividend yield | `null` → rendered "n/a" | derived TTM ÷ price |
| #10 Balance sheet + cash flow | `earnIncome()` invented ratios | `financials/{ticker}` from `/vX/reference/financials` |
| #11/#16 EPS history | `earnHistory()` symbol hash | `fin.epsHistory` — real `epsActual` vs `epsEstimate` |

⚠️ **#11/#16 deserve a caveat rather than a clean tick.** The EPS *actuals* are real, but the *estimates* come from `earnings_events`, which is FMP — the source measured at **10 rows/week** (§C.3). Coverage is therefore thin, and a quarter with no estimate records a surprise of **0** rather than an invented one (deliberate, but it renders as "in line"). The price-reaction column has no source and is hard-coded to `0`. The caption still says "illustrative" even when the data is real — that copy should now be conditional.

⚠️ **The 52-week row is the one to understand.** `p × 0.58 / p × 1.02` is not merely imprecise — because both bounds were multiples of the **live** price, the range moved with the quote and the "% from 52-week high" was a constant for every stock. Any screenshot taken before this change shows a range that never existed.

⚠️ **Why several rows are LIVE→fallback rather than LIVE.** The code still reads e.g. `liveCompany?.low52 ?? p * (rs > 60 ? 0.58 : 0.78)` and `vwap != null ? nf(vwap) : nf(p * 0.994)`. For a ticker the `technical-indicators` job has not covered, the **old fabricated value renders with no visual difference**. #8 does gate the 52-week widget on `has52w`, but VWAP, peers and the dividend card do not. Removing the fallbacks (render "—") would close this out.

🔴 **Not fixed on this screen:** #5 EPS surprise pane (`EarnPane` still calls `earnHistory()` directly — note it now sits on the same screen as #11/#16, which do read real EPS), #6 pattern callout, #9 AI technical analysis, #14 industry rank, #18 key levels, and the Short Interest keystat + institutional ownership % in #8/#17. Short interest returns **404** on this plan (A.1.0) — it needs FINRA's files, not a Polygon upgrade.

🆕 **2026-08-16 — the LIVE→fallback rows above no longer fall back for a first-time ticker.** `/live/company` (`ondemand.getCompany`) used to return a slim profile-only doc, so `peRatio`, `eps`, `dividendYield`, `dividendPerShare`, `peers`, the indicator keystats (`rsi14`/`macd`/`stochK`/`adx14`/`beta`, SMA ladder, `high52`/`low52`, `keyLevels`) and the Technical/RS Rating (#12) rendered the fabricated fallback until the nightly crons covered the ticker. The first on-demand fetch now computes the technicals inline and ranks the RS + tech rating on-demand against the cached universe's stored raw-score distribution (`rsScore`/`techMomentum`/`techTrend`/`techRsi`, now persisted by the crons), so real values render immediately for a brand-new ticker. Existing cron ranks stay authoritative; ~2yr of bars are persisted to `ohlcv_bars` so the crons rank the ticker on their next pass. The fabricated fallbacks remain in the code only as a last resort.

---

## B.3 Earnings Hub — `app/iq/screens/earnings.tsx` · **9 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Embedded Earnings Calendar | API | see B.4 | FMP | `/stable/earnings-calendar` | **Finnhub ✅** |
| 2 | Selected-company detail card | HYBRID | **BUG — falls back to `EARN_CAL[0]`=AMD** | FMP | `/stable/earnings-calendar` | Finnhub ✅ (adds session, quarter) |
| 3 | Company bio | STATIC | `COMPANY_BIO` (42 entries) | — | — | `companies.description` ✅ (already synced) |
| 4 | EPS history chart | GENERATED | `earnHistory()` | — | — | Finnhub `/calendar/earnings` ✅ |
| 5 | Income statement chart | GENERATED | `earnIncome()` | — | — | SEC XBRL (free) |
| 6 | AI earnings read | GENERATED | template string | — | — | Anthropic API |
| 7 | Earnings call drawer | STATIC | `CALLS_DATA` hand-written | — | — | FMP transcripts (paid) · API Ninjas |
| 8 | AI analysis modal | STATIC | `CALLS_DATA` | — | — | Anthropic API |
| 9 | Open full stock page | NONE | navigation | — | — | — |

---

## B.4 Earnings Calendar — `app/iq/screens/earnings-calendar.tsx` · **6 features**

**The only fully-live screen.** No mock fallback by design — an empty day renders empty.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Date navigator + Day/Week toggle | NONE | client state | — | — | — |
| 2 | Filter bar (Cap/Sort/View/Has news/Today) | NONE | client-side over fetched rows | — | — | — |
| 3 | Upcoming IPOs block | API | `ipos` | Polygon → Finnhub | `/vX/reference/ipos` | Finnhub `/calendar/ipo` ✅ (already fallback) |
| 4 | Day table 🆕 | API | `earnings_events` ⋈ `companies` ⋈ `news`; **full-US as of 2026-08-16** — forward symbols resolved against the Polygon `tickers` ref, not filtered to the ~385 tracked `companies` (Aug 26 2026: 4 → 38 reporters) | FMP + Polygon ref | `/stable/earnings-calendar`, `/v3/reference/tickers` | **Finnhub ✅ — would restore session column** |
| 5 | Week grid | API | same, reshaped | FMP | same | Finnhub ✅ |
| 6 | News count badge | API | `news` | Polygon + Finnhub | `/v2/reference/news` | Marketaux · GDELT |

**Columns omitted for lack of any data source:** Before Open/After Close (FMP has no session field — **Finnhub does**), Typical move, Guidance, Reaction.

---

## B.5 Movers — `app/iq/screens/movers.tsx` · **7 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Tab bar + "N live" counter | HYBRID | aggregate of #5 | FMP → Polygon | — | — |
| 2 | Trending across reports | GENERATED | days = `2 + charCodeAt(0)%4` | — | — | Compute from `news` frequency |
| 3 | Sector / cap filters | NONE | client filter | — | — | — |
| 4 | Sector tally pills | HYBRID | count over #5 | — | — | — |
| 5 | Movers table | HYBRID | `market_movers` + `companies.rvol`; **catalyst / MA posture / week% / tech context always static** | FMP → Polygon | `/stable/biggest-gainers`, `/losers` | Polygon grouped-daily ✅ (has volume; FMP does not) |
| 6 | Intraday sparkline | GENERATED | seeded random walk | — | — | 🆕 **Plan check done — authorized.** `intraday_bars` is now synced; thread it through as the charts in B.21 now do |
| 7 | Stock detail drawer | — | embeds B.2 | — | — | — |

---

## B.6 Screener — `app/iq/screens/screener.tsx` · **6 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Preset filter chips | STATIC | `screenerPresets` | — | — | — (legitimate config) |
| 2 | Manual filter groups | NONE | client filter; **some checkboxes are disabled no-ops** | — | — | — |
| 3 | Save screen | USER | **`localStorage`** | — | — | Migrate to Firestore |
| 4 | Match count + "N live" | HYBRID | aggregate of #5 | — | — | — |
| 5 | Results list | HYBRID | `companies` overlays cap/PE/RS/tech/rvol/growth | Polygon + computed | `/v3/reference/tickers/{ticker}`, `/vX/reference/financials` | SEC XBRL for fundamentals |
| 6 | Chart + detail panel 🆕 | **LIVE** | `stock-panel.tsx` now passes `realBars={useChartBars(sym, tf)}` | Polygon | intraday + daily aggs | — (fixed) |

---

## B.7 Watchlist — `app/iq/screens/watchlist.tsx` · **5 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Add stock + modal | USER | `users/{uid}/watchlists/default` (`arrayUnion`); **local-only when signed out, no warning** | — | — | — |
| 2 | AI watchlist summary | GENERATED | template + hardcoded "Nasdaq +1.02%, S&P 500 +0.73%" | — | — | Anthropic API; index values from `market_indices` ✅ |
| 3 | Watchlist rows | HYBRID/USER | watchlist doc ⋈ `companies` | Polygon | `/v3/reference/tickers/{ticker}` | Finnhub `/quote` |
| 4 | Remove-stock modal | USER | `arrayRemove` | — | — | — |
| 5 | Chart + detail panel 🆕 | **LIVE** | `stock-panel.tsx` now passes real bars + real RSI | Polygon | intraday + daily aggs | — (fixed) |

---

## B.8 Portfolio — `app/iq/screens/portfolio.tsx` · **8 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | **Import from photo** | **FAKE** | `setTimeout` → hardcoded `NVDA 15 / AAPL 120 / MSFT 60`; **no image is read** while UI says "Scanning image with AI…" | — | — | Anthropic API vision (key already provisioned) |
| 2 | Add holding + modal | USER | `users/{uid}/portfolios/default/holdings/{ticker}` | — | — | — |
| 3 | AI portfolio summary | GENERATED | template | — | — | Anthropic API |
| 4 | Holdings list + total | HYBRID/USER | holdings ⋈ `companies` | Polygon | `/v3/reference/tickers/{ticker}` | Finnhub `/quote` |
| 5 | Shares input | STATIC/USER | `DEFAULT_SHARES` merged with user `shares` | — | — | — |
| 6 | Totals write-back | USER | writes `totalValue/dayPL/dayPLPct` | — | — | — |
| 7 | Remove-holding modal | USER | `deleteDoc` | — | — | — |
| 8 | Chart + detail panel 🆕 | **LIVE** | `stock-panel.tsx` now passes real bars + real RSI | Polygon | intraday + daily aggs | — (fixed) |

---

## B.9 Heatmap — `app/iq/screens/heatmap.tsx` · **4 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Stocks / S&P 500 tabs | NONE | **dead control** — state set, never read | — | — | — |
| 2 | Color legend | NONE | static legend | — | — | — |
| 3 | Treemap | HYBRID | `companies` + `sectors` over static `sectorList` universe | Polygon | `/v3/reference/tickers/{ticker}` | FMP `/sector-performance-snapshot` ✅ |
| 4 | Hover tooltip | HYBRID/STATIC | Price/RVOL/MA from **static `movers`**, not the live-merged list | — | — | Use the live-merged list already on-screen |

---

## B.10 Themes — `app/iq/screens/themes.tsx` · **4 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Theme filter pills | STATIC | `THEMES` — frozen prices (NVDA pinned `$1181.75`) | — | — | — (basket definitions are legitimate config) |
| 2 | AI theme summary | GENERATED | template despite "◆ AI theme summary" | — | — | Anthropic API |
| 3 | Constituents list | HYBRID | `companies` overlays frozen prices | Polygon | `/v3/reference/tickers/{ticker}` | Finnhub `/quote` |
| 4 | Chart + detail panel 🆕 | **LIVE** | `stock-panel.tsx` now passes real bars + real RSI | Polygon | intraday + daily aggs | — (fixed) |

⚠️ The chart is now real, but the **constituent prices in `THEMES` are still frozen literals** (NVDA pinned `$1181.75`) that `companies` overlays. A real chart above a stale pinned price is a *worse* mismatch than two synthetic values agreeing with each other — worth fixing next.

---

## B.11 Macro — `app/iq/screens/macro.tsx` · **10 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Market regime card | STATIC | hardcoded "Risk-On Rally" | — | — | Anthropic API + `market_indices` |
| 2 | VIX card | STATIC | hardcoded `14.18 / ▼-2.51%` — **Dashboard's VIX card is live** | — | — | `market_indices` VIXY ✅ (already synced) |
| 3 | Economic calendar | HYBRID | `macro_events`; silent fallback to hardcoded arrays | FRED | `/series/observations` | — already optimal (free, authoritative) |
| 4 | Live Economic Indicators ✅labeled | API | `macro_events` | FRED | `/series/observations?series_id=…&limit=2` | — |
| 5 | Dividend calendar (Day/Week tabs) | API | `dividends` | Polygon → FMP | `/v3/reference/dividends` | FMP `/dividends-calendar` ✅ (has yield) |
| 6 | Dividend calendar — **Month tab** | STATIC | reads only `DIV_STOCKS`, never live | — | — | Point at `dividends` ✅ (already synced) |
| 7 | Live Dividend Calendar ✅labeled | API | `dividends` | Polygon | `/v3/reference/dividends` | Finnhub `/stock/dividend` |
| 8 | VIX Sensitive Stocks | STATIC | `VIX_STOCKS` beta/IV30 | — | — | `companies.beta` ✅ (already synced) |
| 9 | 10-yr dividend history chart 🆕 | **LIVE** | `dividend_history/{ticker}.byYear[]` — real annual totals | Polygon | `/v3/reference/dividends` (full history) | Finnhub `/stock/dividend` |
| 10 | Dividend CAGR / streak 🆕 | **LIVE** | `dividend_history.cagr5y` / `.increaseStreak`; still `null`→"—" | Polygon | `/v3/reference/dividends` | — |

🆕 `divHistory()` — which decayed a synthetic series by symbol hash — is superseded by the `corporate-actions` job (A.1.11). Rows 1–3 and 8 on this screen (market regime, VIX card, VIX-sensitive stocks) are **unchanged and still hardcoded**; note the Macro VIX card remains a frozen `14.18` even though the Dashboard's VIX card (B.1 #14) is live off the same collection.

---

## B.12 Insider & 13F — `app/iq/screens/insider.tsx` · **12 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Most-active-by-$ chips | HYBRID | `insider_transactions` + `BUYERS`/`SELLERS` | SEC EDGAR | `/submissions/CIK{10-digit-CIK}.json` | — already optimal |
| 2 | Insider activity table ✅labeled | HYBRID | merged feed; live rows pilled | SEC EDGAR | Form 4 XML | — |
| 3 | Insider stock drawer | HYBRID | live filings + `insiderHistory()` **generated, unlabeled** | SEC EDGAR | Form 4 XML | Widen the EDGAR lookback instead of generating |
| 4 | Most-active institutional chips | GENERATED | `instMeta()` hash-fabricated | — | — | Derive from `fund_holdings` ✅ (already synced) |
| 5 | Institutional activity table | GENERATED | `INST_DATA` fabricated | — | — | Derive from `fund_holdings` ✅ |
| 6 | Top tracked funds ✅labeled | HYBRID | `fund_holdings` fuzzy-matched onto static `funds` | SEC EDGAR | 13F info-table XML | — |
| 7 | Institutional drawer | STATIC+GENERATED | `mutualFunds()`, `instQuarters()` | — | — | `fund_holdings/{cik}/filings/*/positions` ✅ |
| 8 | AI 13F Summary | STATIC | hardcoded, frozen at "Berkshire · Q1 2024" | — | — | Anthropic API over `fund_holdings` |
| 9 | Cross-fund signals | STATIC | `CROSS_OWN`/`CROSS_SOLD`/`CROSS_LONE` | — | — | Compute from `fund_holdings` ✅ (#10 already does) |
| 10 | Live overlap (CUSIP-matched) ✅labeled | API | `fund_holdings/{cik}/filings/{acc}/positions` | SEC EDGAR | 13F XML | — |
| 11 | View toggle | NONE | — | — | — | — |
| 12 | Filter & sort bars | NONE | — | — | — | — |

---

## B.13 Options — `app/iq/screens/options.tsx` · **5 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Stock search sidebar | STATIC | `movers` + `EXTRA_STOCKS` | — | — | `tickers` ✅ (already synced) |
| 2 | Stock header | STATIC | same list | — | — | `companies` ✅ |
| 3 | Expiry date tabs | STATIC | `EXPS` | — | — | `options_chains.contracts[].expirationDate` ✅ |
| 4 | Options chain table ✅labeled | GENERATED | `buildChain()` sinusoidal PRNG — **still fabricated** | — | — | **Tradier (token already provisioned, unwired)** · CBOE delayed · Alpaca |
| 5 | Live Options Reference ✅labeled 🆕 | API | `options_chains` — now incl. per-contract OHLC, VWAP, volume, trade count, traded range % | Polygon | `/v3/reference/options/contracts` + `/v2/aggs/ticker/O:…` | Tradier — adds bid/ask, IV, greeks, OI that Polygon's plan lacks |

🆕 **Partial improvement only — read this before claiming the Options screen is fixed.** Option *contract aggregates* are authorized, so **price, volume, VWAP and trade count per contract are now real** (15-min delayed). But **bid/ask, implied volatility, greeks and open interest still return `NOT_AUTHORIZED`** (A.1.0) — they need the Options add-on or Tradier. Since those four are what the chain table in #4 mainly displays, `buildChain()` is **still in place and still fabricating**, and the "Simulated data" label must stay.

---

## B.14 Analyst — `app/iq/screens/analyst.tsx` · **7 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Tabs | NONE | — | — | — | — |
| 2 | Cluster alert card | STATIC | `computeClusters()` over static `analyst` | — | — | Finnhub `/stock/recommendation` ✅ history |
| 3 | Multiple-upgrades card | STATIC | same | — | — | Finnhub ✅ |
| 4 | Live consensus card ✅labeled | API | `analyst_actions` | FMP | `/stable/grades-consensus` | **Finnhub `/stock/recommendation` ✅ (adds monthly history)** |
| 5 | AI take · cluster | STATIC | hardcoded paragraph | — | — | Anthropic API |
| 6 | Filter bar | NONE | — | — | — | — |
| 7 | Full actions table | HYBRID | static `analyst` (**real firm names, invented ratings/PTs**) + live pill | FMP | `/stable/grades-consensus` | Benzinga (paid, key unwired) for real per-firm actions |

---

## B.15 Commentary — `app/iq/screens/commentary.tsx` · **9 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Tabs | NONE | — | — | — | — |
| 2 | Ticker search + suggestions | STATIC | `stockInfo`/`screenerStocks`/`movers` | — | — | `tickers` ✅ |
| 3 | Main feed 🆕 | HYBRID | `news` + hardcoded `PREMARKET`/`AFTERHOURS`; live pilled. **2026-08-16: Polygon + FMP merge**, each article badged by `vendor` (`polygon`\|`fmp`) with publisher `source`, `sentiment` pill and thumbnail (FMP `sentiment` often null) | Polygon + FMP | `/v2/reference/news`, `/stable/news/stock` | Marketaux · GDELT · RSS |
| 4 | Quick lookup / tracked chips | STATIC | fixed list or `watch`/`folio` | — | — | — |
| 5 | Before the Bell | STATIC + 🆕 live moves | hardcoded copy; **`useExtendedHours` supplies real pre-market % — localhost only** | Polygon | `/v3/snapshot` → backend `/live/*` | Anthropic API over `news` for the narrative |
| 6 | After the Close | STATIC + 🆕 live moves | same, `lateTradingChangePct` | Polygon | `/v3/snapshot` | Anthropic API |

🔴 **#5/#6 do not work in production.** `useExtendedHours` reads the backend, and the production bundle has `NEXT_PUBLIC_BACKEND_URL` unset — it calls `http://localhost:4400`, blocked as mixed content from an HTTPS origin. **On https://marketcatalyst.web.app these two cards show the hardcoded copy only.** The extended-hours wiring is real and verified on localhost; do not describe it as shipped to users until §D.4 gap 1 is closed. The surrounding narrative copy is hardcoded in either environment.
| 7 | General perspective | STATIC | hardcoded "Risk-On Rally… VIX at 14" | — | — | `market_indices` ✅ + Anthropic |
| 8 | News history drawer ✅labeled | HYBRID | `news` + `buildNewsHistory()` generated | Polygon + Finnhub | `/company-news` | Widen the news lookback |
| 9 | "No company associated" drawer | NONE | informational | — | — | — |

---

## B.16 EOD Recap — `app/iq/screens/recap.tsx` · **11 features**

⚠️ **Zero live wiring on this entire screen.** Always renders "Tuesday, May 21" content as today's recap.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Today / This Week tabs | NONE | — | — | — | — |
| 2 | Hero headline + index chips | STATIC | `recap`, `WEEKLY` | — | — | `market_indices` ✅ |
| 3 | 60-sec audio recap | NONE | **no handler at all** | — | — | TTS vendor |
| 4 | Download PDF | GENERATED | one-line `.txt` blob | — | — | Real PDF lib |
| 5 | Key stories | STATIC | `recap.stories` | — | — | `news` ✅ + Anthropic |
| 6 | Up-next list | STATIC | `recap.tomorrow` | — | — | `earnings_events` + `macro_events` ✅ |
| 7 | News Briefing + social share | STATIC | `NEWS_DAILY`/`NEWS_WEEKLY`; footer claims "AI-generated" | — | — | Anthropic API over `news` |
| 8 | Sector heatmap | STATIC | `sectorList` (raw, not live-merged) | — | — | `sectors` ✅ |
| 9 | Biggest earnings movers | STATIC | `recap.movers` | — | — | `market_movers` ✅ |
| 10 | Market internals | STATIC | `recap.internals` | — | — | Compute from Polygon grouped-daily ✅ |
| 11 | Drill-down drawer | STATIC | `recap.movers` + `earnings` | — | — | — |

---

## B.17 IPOs — `app/iq/screens/ipos.tsx` · **6 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Stats strip | HYBRID | live rows have `cur`/`day1` = `null`, so stats **only populate from mock** | Polygon → Finnhub | `/vX/reference/ipos` | Join `ohlcv_bars` for aftermarket price ✅ |
| 2 | Sector filter ✅labeled | NONE | count line appends "· sample data" — **best-practice example** | — | — | — |
| 3 | Recent IPO performance table | HYBRID | live offer price; current/day1/return `—` | Polygon → Finnhub | `/vX/reference/ipos` | Join `ohlcv_bars` ✅ |
| 4 | Upcoming pipeline | STATIC | `PIPELINE` | — | — | SEC S-1/424B filings (free) |
| 5 | Live IPO Calendar ✅labeled 🆕 | API | `ipos`; **Shares + Deal size columns now shown** (`numberOfShares`/`totalSharesValue`, 2026-08-16 — were synced but unshown) | Finnhub | `/calendar/ipo` | Polygon `/vX/reference/ipos` ✅ (already primary) |
| 6 | Footnote | — | claims "SEC EDGAR + Polygon.io" — aspirational | — | — | — |

---

## B.18 Settings — `app/iq/screens/settings.tsx` · **8 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Account card | USER | Redux profile + Firebase Auth; "Pending" chip | — | — | — |
| 2 | Edit Profile / Sign Out | NONE | navigation | — | — | — |
| 3 | Dark-mode toggle | USER | `settings/{uid}.darkMode` + `localStorage` | — | — | — |
| 4 | Alerts toggle | USER | `settings/{uid}.alert` | — | — | — |
| 5 | Font picker | USER | `settings/{uid}.font` | — | — | — |
| 6 | Plan card | USER | `profile.tier` | — | — | — |
| 7 | **Schedule & share recap** | **FAKE** | shows "✓ Recap scheduled" for 4s; **no write, no email** | — | — | Cloud Scheduler + SendGrid/SES |
| 8 | Delete account | USER | real `deleteUser()`, typed-"DELETE" confirm | — | — | — |

---

## B.19 Manage Plan — `app/iq/screens/manage-plan.tsx` · **4 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Current Plan card | USER | `profile.tier` + Firebase Auth | — | — | — |
| 2 | Free/Premium pricing cards | STATIC | hardcoded $0/$19; **buttons have no `onClick`** | — | — | Stripe |
| 3 | Feature comparison table | STATIC | `FEATURES` | — | — | — (legitimate copy) |
| 4 | Billing & Support | NONE | **all three buttons have no handlers** | — | — | Stripe billing portal |

---

## B.20 App Shell — `app/iq/shell.tsx` + `notification-bell.tsx` · **16 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Ticker marquee 🆕 | **API (streamed)** | SSE `/live/tape/stream` over `market_indices` over static `pulse` | Polygon | `/v3/snapshot?ticker.any_of=` | Finnhub `/quote` |
| 2 | Nav rail | STATIC | `menuItems` | — | — | — (legitimate config) |
| 3 | Command ⌘K search | HYBRID | live `tickers` query + `SEARCHABLE_STOCKS` | Polygon | `/v3/reference/tickers` | SEC `company_tickers.json` (free) |
| 4 | Notification bell | API | `users/{uid}/notifications` | Polygon + Finnhub (via news job) | `/v2/reference/news` | — |
| 5 | Theme toggle | USER | `settings/{uid}` | — | — | — |
| 6 | **AI Copilot** | GENERATED | 4 hardcoded replies cycled; panel claims "Connected to your portfolio · live data" | — | — | **Anthropic API (key provisioned, unused)** |
| 7 | Profile avatar + dropdown | HYBRID | Redux profile + Auth `photoURL` | — | — | — |
| 8 | Market status pill 🆕 | HYBRID (local) | `getMarketStatus()` — ET-aware via `Intl.DateTimeFormat`/`America/New_York` + holiday table; `fetchMarketStatus()` overlays the vendor session **localhost only** | Polygon | `/v1/marketstatus/now` (via backend `/live/market-status`) | — |
| 9 | Nav clock "ET" | GENERATED | `new Date().toLocaleTimeString("en-US")` labeled ET **without timezone conversion** — 🔴 **still a bug** | — | — | `Intl.DateTimeFormat` w/ `America/New_York` — the pattern is already in `market-status.ts`, just unused here |
| 10 | Stock drawer | STATIC | `movers`/`screenerStocks` | — | — | `companies` ✅ |
| 11 | Earnings drawer | STATIC | `earningsData`; "◆ AI Summary · conf. 91%" is a template | — | — | `earnings_events` ✅ + Anthropic |
| 12 | Sector drawer | STATIC | `sectorByName` + 3 hardcoded news items | — | — | `sectors` + `news` ✅ |
| 13 | Fund drawer | STATIC | `funds`/`fundDetail` | — | — | `fund_holdings` ✅ |
| 14 | Index drawer | HYBRID | now fed by the streamed tape (`applyTape`), so it agrees with the tile that opened it; 52wk range still **fabricated** as `×1.06` | Polygon | `/v3/snapshot` | Compute from `ohlcv_bars` ✅ |
| 15 | Fear & Greed drawer | STATIC | hardcoded 62 + 7 component scores — **the drawer is still static even though the gauge (B.1 #15) is now live** | — | — | `market_sentiment` ✅ (rule now exists) |
| 16 | Mover detail drawer | — | embeds B.2 | — | — | — |

🆕 **#8 vs #9 — the shell got half a timezone fix.** `market-status.ts` computes the session correctly: DST-aware ET extraction, a holiday table through 2027, and pre/regular/after boundaries. The nav clock two lines away (#9) still formats the **browser's** local time and appends the literal "ET". Both were listed as one bug (D.1 #4) in the first pass; **only the pill was fixed.**

⚠️ The pill's holiday table is **hardcoded through 2027** and will silently go stale after that, and it cannot know about an unscheduled halt or an early close. The vendor endpoint that would fix both is wired but unreachable in production (§D.4 gap 1).

---

🆕 **2026-07-22 — the ticker marquee is live and streamed (#1).** It was `mergePulse(pulse, market_indices)`, and `market_indices` is written by a job on cron `5 18 * * 1-5` — so between the opening bell and 18:05 ET the header showed **yesterday's closes**, over a static mock. It now renders `GET /live/tape/stream` (SSE): 8 index ETF proxies + the 10Y yield + 12 mega-caps, refreshed every 60 s.

The fan-out property is the point. **One** `/v3/snapshot?ticker.any_of=` call per minute covers all 21 instruments and is broadcast to every connected browser, so upstream cost is independent of how many people have the app open — measured at 25 concurrent clients / ~3 min / **3** vendor calls, not 75. The poller is ref-counted against connected clients, so an app nobody has open makes zero calls. Firestore/mock remain as ordered fallbacks, so a backend outage degrades the strip to yesterday's real closes rather than blanking it.

⚠️ Index tiles remain **ETF proxies** (SPY/QQQ/DIA/IWM/VIXY/USO/GLD/UUP), so "S&P 500" reads ~750, not ~5,300 — the current plan does not include index data. That is pre-existing behaviour inherited from `market-indices.job.ts`, now merely visible intraday; `isProxy` and `note` travel on every item.

🆕 **#8 and the extended-hours cards (§B.7) unblock with this.** All three read the backend through `NEXT_PUBLIC_BACKEND_URL`, which was unset in the production build — §D.4 gap 1. Shipping the public `market-catalyst-live` service (deploy/DEPLOY.md §3b) sets that variable and closes the gap for all of them at once.

---

## B.21 Shared chart panel — `app/iq/stock-panel.tsx` · **7 features**

🆕 **2026-07-22 — this section's headline finding is resolved.** It previously read: *"Nothing in this file ever passes real bars to `CandleChart` — every chart here is synthetic. Affects Screener, Watchlist, Portfolio, Themes."* `ChartCard` and the expand modal now call `useChartBars(sym, tf)` and pass `realBars`; `RsiPane` receives `series={company?.rsi14Series}`. This was the highest-leverage single fix in the app — one file feeds **every** chart on **Screener, Watchlist, Portfolio and Themes**, so four screens changed classification from one change.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | `StockRow` sparkline | GENERATED | `sparkSVG()` seeded 20-point path — **still synthetic** | — | — | `intraday_bars` / `ohlcv_bars` ✅ (now synced) |
| 2 | `StockListCard` | NONE | layout | — | — | — |
| 3 | `ChartCard` candlestick 🆕 | **LIVE** | `realBars={useChartBars(sym, tf)}` | Polygon | intraday + daily aggs | — (fixed) |
| 4 | RSI pane 🆕 | **LIVE** | `series={company?.rsi14Series}` | computed from `ohlcv_bars` | — | — (fixed) |
| 5 | Earnings pane | GENERATED | `earnHistory()` — **still synthetic** | — | — | Finnhub `/calendar/earnings` ✅ |
| 6 | Expand-chart modal 🆕 | **LIVE** | same as #3 | Polygon | intraday + daily aggs | — (fixed) |
| 7 | `StockPanelLayout` | NONE | layout | — | — | — |

⚠️ **Two fabricators survive in this file:** the `StockRow` sparkline (#1) and the earnings pane (#5). A row whose sparkline is synthetic can now sit directly above a chart that is real — an inconsistency that did not exist when everything here was fake.

---

## B.22 Public landing page — `app/page.tsx` · **16 features**

Zero Firestore calls; all thumbnails render `data.ts` mocks + `genOHLC()`/`earnHistory()`. **Acceptable for a logged-out marketing page** — flagged for completeness, not as a defect.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Nav bar | NONE | — | — | — | — |
| 2 | Hero section | STATIC | copy | — | — | — |
| 3 | Workspace marquee (8 cards) | STATIC | `WS_LIST` | — | — | — |
| 4–11 | Screen thumbnails (Dashboard, Movers, Stock, Heatmap, Earnings, Analyst, Portfolio, Recaps) | STATIC + GENERATED | `data.ts` + `genOHLC()`/`earnHistory()` | — | — | — |
| 12 | "And many more" card | NONE | — | — | — | — |
| 13 | Glance modal | STATIC | `WS_LIST[i]` copy | — | — | — |
| 14 | Auth modal + Google sign-in | API | real `signInWithPopup()` | Firebase Auth | — | — |
| 15 | Pricing section | STATIC | $0/$29/$79; buttons open signup, **no billing wired** | — | — | Stripe |
| 16 | Final CTA + WebGL background | NONE | decorative | — | — | — |

---

## 🆕 B.23 Plans & entitlements — `src/plans/` + `app/iq/entitlements.tsx` · **12 features**

New since 2026-07-20. Backend module `src/plans/`; frontend `entitlements.tsx` + `entitlement-gate.tsx`.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Plan catalogue | **LIVE** | `plans` collection (3 docs), seeded from `plans.registry.ts` | — | `GET /plans` | — (own data) |
| 2 | Plan seeding | **LIVE** | `plans.service.ts`, **merge-based** so operator edits survive re-seed | — | `POST /plans/seed` (admin) | — |
| 3 | Effective subscription | **LIVE** | `subscriptions.service.ts` over `users/{uid}` | — | `GET /users/:uid/entitlements` | — |
| 4 | `EntitlementProvider` / `useSubscription` | **LIVE** | `plans` ⋈ `users/{uid}` read client-side | — | — | — |
| 5 | `useEntitlement(key)` | **LIVE** | 16-key flag map from the user's plan | — | — | — |
| 6 | `EntitlementGate` / `PlanGate` | NONE | UI gate over #5 — renders the upgrade panel | — | — | — |
| 7 | `useSlugEntitled` — nav hiding | NONE | `SLUG_ENTITLEMENT` map over #5 | — | — | — |
| 8 | `formatAmount()` | NONE | minor-unit → display string | — | — | — |
| 9 | Settings Plan card | USER | `profile.tier` — **not yet migrated to #3** | — | — | — |
| 10 | Manage-Plan pricing cards | STATIC | hardcoded $0/$19; **still no `onClick`** | — | — | Stripe |
| 11 | Landing pricing section | STATIC | $0/$29/$79 — **disagrees with both #1 and #10** | — | — | Stripe |
| 12 | Checkout / billing portal | **NONE — not implemented** | no Stripe code exists in either repo | — | — | Stripe |

### Plans as they exist in Firestore

| id | name | amount | currency | cycle | entitlements |
|---|---|---|---|---|---|
| `free` | Free | 0 | USD | none | 8 / 30 |
| `plus` | Plus | 2999 | USD | monthly | 20 / 30 |
| `pro` | Pro | 4999 | USD | monthly | 28 / 30 |

🔴 **Amounts are MINOR units (cents), matching Stripe.** `4999` is **$49.99**, not $4,999. Any consumer that renders `amount` directly is off by 100×; use `formatAmount()`.

The ladder is cumulative:

| Tier | Adds |
|---|---|
| Free | `marketCatalyst`, `news`, `scanner`, `heatmap`, `macro`, `ipos`, `chartsDaily`, `watchlist` |
| Plus | + `chartsIntraday`, `chartsHistory`, `chartIndicators`, `chartNotes`, `technicalRatings`, `dividendHistory`, `peers`, `earningsDetail`, `portfolio`, `screener`, `themes`, `alerts` |
| Pro | + `fundamentalRatings`, `ownership`, `optionsChain`, `exportData`, `apiAccess`, `aiAssistant`, `backtesting`, `paperTrading` |

**Pro is 28/30, not 30/30, and that is deliberate.** `adminDashboard` and `userManagement` are **staff-only** and forced `false` on every plan — selling them would be privilege escalation, letting any paying customer read every other customer's record.

### 🔴 The two-layer gating model — do not merge these

| Layer | File | Question it answers | UI when false |
|---|---|---|---|
| **FF_\* release flags** | `feature-flags.registry.ts` | "Is it built and shipped?" | "Coming soon" |
| **Plan entitlements** | `plans.registry.ts` | "May this tier use it?" | "Upgrade to unlock" |

A feature is usable only when **both** are true. They look similar and are tempting to collapse into one flag — **don't**. Merging them makes an unbuilt feature render as a paywall, i.e. the app would offer to sell something that does not exist. `backtesting` and `paperTrading` are the live example: **granted on Pro, but not built**, so they correctly show "coming soon" rather than an upgrade prompt.

⚠️ **Entitlements are granted, not enforced end-to-end.** `apiAccess` is a Pro entitlement, but there is no API-key issuance or metering (`api_usage` is unimplemented — §D.4 gap 5). `alerts` is a Plus entitlement with no alerts engine behind it. Granting a flag is not the same as shipping the feature.

⚠️ **Expiry is computed, never trusted.** Nothing rewrites a user document when a subscription lapses, so `subscriptionStatus` in `users/{uid}` goes stale. `subscriptions.service.ts` therefore derives the effective state from `subscriptionExpiryDate` at read time, and falls back to **FREE** — never to no-access — so a data problem degrades a user to the free tier rather than locking them out.

⚠️ **Three different price lists ship simultaneously** (#1 $0/$29.99/$49.99, #10 $0/$19, #11 $0/$29/$79). Only #1 is real.

---

## 🆕 B.24 Feature-adoption tracking — `app/iq/feature-adoption.ts` + `track-feature.tsx` · **3 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | `TrackFeature` component | **LIVE** | writes `feature_adoption/{feature}_{uid}` | — | Firestore direct | — |
| 2 | Feature catalogue | STATIC | ~48 entries — screens from `menuItems` + 40 in-app actions | — | — | — (legitimate config) |
| 3 | Admin roll-up | **LIVE** | single collection scan, aggregated by feature | — | — | — |

**Tracked surface:** every screen in `menuItems`, plus in-app actions — the 8 stock drawers, chart timeframe / indicator / expand, watchlist add & remove, search, screener, news, and others.

**Document shape:** `feature_adoption/{feature}_{uid}` — one doc per user per feature, carrying `feature`, `uid`, `openCount`, timestamps. **A flat collection with a composite document id, deliberately not a subcollection** — it keeps the admin roll-up to a single collection scan instead of a fan-out across every user.

**Behaviour:** 30-second dedupe per feature so a re-render is not an open; **write failures are swallowed** so analytics can never break a screen.

🔴 **This is the ONLY client-writable analytics collection, and only because the browser cannot reach the backend** (§D.4 gap 1). Server-side instrumentation would be preferable. Its rule is correspondingly tight: the row must belong to the caller, `openCount` may only **increase**, ownership cannot change, and delete is denied. Note the ceiling this implies — a determined client can still inflate its own counts.

⚠️ Currently ~12 seeded documents. Adoption percentages in the admin console are computed off that, so they are **not yet meaningful**.

---

## 🆕 B.25 Admin console — `public/admin/console.html` + `app/admin/admin-data.ts` · **~14 features**

The console is an iframe-embedded static page. `admin-data.ts` builds the dataset from Firestore and stages it in `sessionStorage` **before the iframe mounts**; the console reads it from there.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Users table | **LIVE** | `users` ⋈ `plans` | — | Firestore (+ `GET /admin/users`) | — |
| 2 | Subscriptions view | **LIVE** | `users` + computed expiry | — | `GET /admin/subscriptions` | — |
| 3 | Revenue KPIs | **LIVE→empty** | `payments` — **collection is empty**, so every figure is 0 | — | `GET /admin/revenue` | Stripe |
| 4 | Plans table | **LIVE** | `plans` | — | `GET /plans` | — |
| 5 | Per-plan feature editor | **LIVE** | writes `plans/{id}.featureFlags` | — | Firestore (rule-constrained) | — |
| 6 | Feature-adoption panel | **LIVE** | `feature_adoption` roll-up (B.24) | — | Firestore | — |
| 7 | Monitor tab | **NONE in production** | iframes the backend ops UI — unreachable from the browser | — | backend `/` | — |
| 8 | Usage & API KPIs | **NONE** | `api_usage` never written — reads 0 | — | — | Implement metering middleware |
| 9 | Engagement columns | **NONE** | watchlists / holdings / apiCalls / alerts per user — **no collection behind them**, all 0 | — | — | Aggregate from `users/{uid}/…` |
| 10 | Audit log | **NONE** | `audit_logs` empty | — | — | — |
| 11 | Trend deltas | **suppressed** | fabricated deltas hidden when real data is present | — | — | Compute from history |
| 12 | MRR history chart | **suppressed** | fake series hidden when real data is present | — | — | Requires `payments` |
| 13 | Staff exclusion | **LIVE** | staff UIDs/emails filtered from every metric | — | — | — |
| 14 | Expiry / status derivation | **LIVE** | lapsed subscriptions recomputed at read time | — | — | — |

🆕 **#11/#12 — the honest-fallback pattern worth copying.** The console shipped with fabricated trend arrows and a fake MRR curve as design filler. Rather than let them render beside real numbers, they are **suppressed when real data is present**. This is the opposite of the pattern D.2 criticises everywhere else in the app, and is the model the rest of the UI should follow.

🔴 **Staff accounts are excluded from every metric.** Without this the operator's own account inflates user counts, adoption rates and engagement on a small dataset.

🔴 **Half this console reads zeroes**, because `payments`, `subscriptions`, `api_usage`, `audit_logs`, `revenue_summary` and `system_metrics` are all **empty** — they are specified, ruled and read, but nothing writes them. A zero here means "not implemented", not "no activity".

### Firestore rules behind the console

| Collection | Rule |
|---|---|
| `plans` | admin may update **`featureFlags` + `updatedAt` only**; create/delete denied |
| `payments`, `subscriptions` | admin reads all; a user reads only their own |
| `api_usage`, `feature_adoption`, `audit_logs`, `revenue_summary`, `system_metrics` | admin read only |
| `feature_adoption` | **only** client-writable analytics collection — see B.24 |
| `users` | owner **or** admin read |
| 🆕 `market_sentiment`, `stock_comments` | **added** — previously had no rule at all (B.1 #15, B.2 #7) |

🔴 **`plans` price fields are server-only by rule.** The admin UI can toggle entitlements but cannot touch `amount`, `currency` or `cycle` — a client able to rewrite `amount` could set a plan to $0 and grant itself Pro.

⚠️ **`isAdmin()` is `token.admin == true` OR `token.email == ADMIN_EMAIL`, and deliberately does NOT require `email_verified`.** The admin is a password account with `emailVerified=false`; requiring verification locked the admin out of Firestore **while the backend guard still admitted the same account** — an inconsistent-authorization state that is worse than either extreme. Documented here because it looks like an oversight and will otherwise be "fixed" back into a lockout.

🔴 **The two repos both ship `firestore.rules` and they have DRIFTED.** The **live** ruleset deploys from **`MarketCatalystUI/firestore.rules`**. The backend copy is stale and now carries a DO-NOT-DEPLOY header. Deploying the backend copy would re-break the F&G gauge and chart notes.

---

## B.26 Feature totals by screen

🆕 **Recounted 2026-07-22.** A **LIVE→fb** column is added for rows that read a real field but still carry the old fabricated value as a fallback (see §0). Changed cells are marked 🆕.

| Screen | Features | LIVE | LIVE→fb | HYBRID | STATIC | GENERATED | USER | NONE/FAKE |
|---|---|---|---|---|---|---|---|---|
| Dashboard | 17 | 0 | 🆕 1 | 🆕 8 | 2 | 2 | 0 | 4 |
| **Stock Detail** | 18 | 🆕 **2** | 🆕 **7** | 🆕 2 | 2 | 🆕 **4** | 1 | 0 |
| Earnings Hub | 9 | 1 | 0 | 1 | 3 | 3 | 0 | 1 |
| **Earnings Calendar** | **6** | **4** | 0 | 0 | 0 | 0 | 0 | 2 |
| Movers | 7 | 0 | 0 | 3 | 0 | 2 | 0 | 2 |
| Screener | 6 | 🆕 1 | 0 | 2 | 1 | 🆕 0 | 1 | 1 |
| Watchlist | 5 | 🆕 1 | 0 | 1 | 0 | 🆕 1 | 2 | 0 |
| Portfolio | 8 | 🆕 1 | 0 | 1 | 1 | 🆕 0 | 4 | 1 (FAKE) |
| Heatmap | 4 | 0 | 0 | 2 | 0 | 0 | 0 | 2 |
| Themes | 4 | 🆕 1 | 0 | 1 | 1 | 🆕 1 | 0 | 0 |
| Macro | 10 | 🆕 5 | 0 | 🆕 2 | 3 | 🆕 0 | 0 | 0 |
| Insider & 13F | 12 | 1 | 0 | 4 | 3 | 2 | 0 | 2 |
| Options | 5 | 1 | 0 | 0 | 3 | 1 | 0 | 0 |
| Analyst | 7 | 1 | 0 | 1 | 3 | 0 | 0 | 2 |
| Commentary | 9 | 0 | 0 | 2 | 5 | 0 | 0 | 2 |
| EOD Recap | 11 | 0 | 0 | 0 | 8 | 1 | 0 | 2 |
| IPOs | 6 | 1 | 0 | 2 | 1 | 0 | 0 | 2 |
| Settings | 8 | 0 | 0 | 0 | 0 | 0 | 6 | 2 (1 FAKE) |
| Manage Plan | 4 | 0 | 0 | 0 | 2 | 0 | 1 | 1 |
| App Shell | 16 | 1 | 0 | 🆕 5 | 6 | 🆕 2 | 2 | 0 |
| **Stock Panel** | 7 | 🆕 **3** | 0 | 0 | 0 | 🆕 2 | 0 | 2 |
| Landing page | 16 | 1 | 0 | 0 | 12 | 0 | 0 | 3 |
| 🆕 Plans & Entitlements | 12 | 5 | 0 | 0 | 2 | 0 | 1 | 4 |
| 🆕 Feature adoption | 3 | 2 | 0 | 0 | 1 | 0 | 0 | 0 |
| 🆕 Admin console | 14 | 7 | 1 | 0 | 0 | 0 | 0 | 6 |
| **Total** | **224** | **39** | **9** | **37** | **59** | **21** | **18** | **41** |

*(The 2026-07-20 pass reported "~185" for a table that summed to 195. This revision reports the exact sum.)*

**Reading of the revised totals:**

- **Purely-live rose from 14 to 39.** On the originally-audited screens alone it went **14 → 25**; the other 14 come from the new plans / adoption / admin surfaces. A further **9** are LIVE→fallback — real when the field is populated, silently fabricated when it is not. **Read the combined 48 with that caveat attached**; it is not the same as 48 unconditionally-live features.
- **GENERATED fell from 36 to 21** — a **42 % reduction**, driven almost entirely by two files: `stock-panel.tsx` (four screens fixed by one change) and `stock.tsx` (10 GENERATED rows down to 4).
- **STATIC rose from 56 to 59.** What remains fabricated is now overwhelmingly **narrative, not numeric** — every AI block, every hand-written recap, every hardcoded commentary paragraph is untouched. *The market-data problem is largely solved; the "AI" problem is not started.*
- **Screens that changed character:** Stock Panel went from **zero** live features to majority-live; Stock Detail from 10 GENERATED to 4; Macro from 3 live to 5.
- **Still no live data at all:** **EOD Recap** and the **landing page** (the latter acceptably so).
- ⚠️ **These totals count what the code does, not what a production browser receives.** Commentary's extended-hours moves and the shell's vendor market-status overlay are counted as wired but do not reach production users — see §D.4 gap 1.

---

# Part C — Free & alternative vendors by data domain

⚠️ **Read this first.** Everything below is marked ✅ only where it was probed against a live key on 2026-07-20. All other rows are ⚠️ from vendor documentation and **must be verified before you rely on them** — free tiers and rate limits change frequently, and several vendors have changed or withdrawn free access in the past. Redistribution rights are a separate question from access: several "free" APIs prohibit redistributing their data in a product you charge for. **Check each vendor's ToS before shipping.**

## C.1 Domain → current provider → alternatives

| Domain | Current | Free / alternative options | Notes |
|---|---|---|---|
| **Ticker universe** | Polygon | SEC `company_tickers.json` (free, no key) · Nasdaq symbol directory (free FTP) · Finnhub `/stock/symbol` | SEC is authoritative for US listings and already in use elsewhere here |
| **Daily OHLCV** | Polygon | Stooq (free CSV, no key) · Tiingo (free tier, EOD) · Alpha Vantage (free, low daily cap) · Twelve Data (free tier) · EODHD | ⚠️ Yahoo Finance's chart endpoint is widely used but **unofficial and against ToS** — not advisable for a paid product |
| **Real-time / delayed quotes** | Polygon (15-min delayed) | Finnhub `/quote` (already wired as fallback) · Alpaca Market Data (free IEX feed) · Twelve Data | Finnhub is already available on the existing key |
| **Company profile** | Polygon → FMP | Finnhub `/stock/profile2` · SEC XBRL `companyfacts` · Alpha Vantage `OVERVIEW` | |
| **Financial statements** | Polygon `/vX/` **(experimental)** — 🆕 now incl. balance sheet + cash flow | **SEC XBRL `companyconcept` / `frames` (free, authoritative, no key)** · Alpha Vantage `INCOME_STATEMENT` | 🔴 **Migration is now MORE urgent, not less.** The 2026-07-22 work wired *more* screens (B.2 #10, `financials` collection) onto the experimental namespace. The blast radius of a `/vX/` deprecation grew |
| 🆕 **Intraday bars** | Polygon minute aggs (`intraday_bars`) | Alpaca (free IEX intraday) · Twelve Data · Tiingo IEX | ✅ Authorized on the existing Starter plan — this was assumed blocked and was not |
| 🆕 **Peers** | Polygon `/v1/related-companies` | FMP `/stable/stock-peers` ✅ (already called) · derive from `companies.sector` | ✅ Authorized on Starter — the prior `FIELD_NOT_SUPPORTED` flag was wrong |
| 🆕 **Treasury yields** | Polygon `/fed/v1/treasury-yields` | **FRED `DGS10` ✅ — free, authoritative, and FRED is already wired** | Arguably FRED is the better source; the Polygon path was chosen because the job already held a Polygon client |
| **Earnings calendar** | FMP (**10 rows/week**) | **Finnhub `/calendar/earnings` — ✅ 488 rows for the same week, plus `hour` (bmo/amc) and `quarter`/`year`** · Nasdaq (unofficial) · Alpha Vantage `EARNINGS_CALENDAR` (CSV) | **See §C.3 — highest-value change available** |
| **Analyst ratings** | FMP `grades-consensus` (snapshot only) | **Finnhub `/stock/recommendation` — ✅ monthly history** · Benzinga (paid; key exists, unwired) | Would give the Analyst screen a real trend instead of a single snapshot |
| **Dividends** | Polygon → FMP · 🆕 `dividend_history` for full payment history | Finnhub `/stock/dividend` · Nasdaq · SEC | Polygon gives no yield on the calendar; FMP does. 🆕 `yieldPct` is now **derived in-house** (TTM ÷ price) for the history collection |
| **IPO calendar** | Polygon → Finnhub | Already dual-sourced · SEC S-1/424B filings for the pipeline | Neither source carries **aftermarket price**, which is why IPO performance stats only populate from mock data (B.17) |
| **News** | Polygon + Finnhub (aggregated) | Marketaux (free tier) · GDELT (free, no key) · NewsAPI (free dev tier, **non-commercial**) · publisher RSS (PR Newswire, Business Wire, GlobeNewswire) | Current aggregate setup is reasonable |
| **News importance / editorial rank** | Heuristic (headline regex + sentiment) | Benzinga `importance` 0–5 (paid — **returns 403 on current plan**) | The heuristic exists specifically because this is gated |
| **Macro / economic** | FRED | — | ✅ Already optimal: free, authoritative, no rate concern |
| **Insider (Form 4)** | SEC EDGAR | — | ✅ Already optimal |
| **Institutional (13F)** | SEC EDGAR | — | ✅ Already optimal |
| **Options chains** | Polygon — 🆕 per-contract OHLC/VWAP/volume now real; **still no bid/ask, IV, greeks, OI** | Tradier (key exists, **unwired**; sandbox gives delayed chains w/ greeks) · CBOE delayed quotes · Alpaca options | 🔴 **Confirmed a genuine plan limit** (403 on the options snapshot endpoint, probed 2026-07-22) — unlike the chart/RSI/peers gaps, this one really does need Tradier or the Options add-on |
| 🆕 **Short interest** | none | FINRA short-interest files (free, bi-monthly) · Nasdaq | 🔴 Polygon returns **404** — no plan upgrade fixes this. The Stock screen keystat is still static |
| **Sector performance** | 11 SPDR ETFs (proxy) | FMP `sector-performance-snapshot` (already the fallback) | No vendor offers true cap-weighted sector aggregates on a cheap tier |
| **Fear & Greed** | Computed in-house from Polygon | CNN's unofficial endpoint | In-house computation is defensible and dependency-free — **keep it** |
| **Earnings transcripts** | None (hand-written mocks) | FMP transcripts (paid add-on) · API Ninjas | Currently `CALLS_DATA` is entirely hand-authored |
| **Institutional ownership %** | Static maps | Finnhub `/stock/ownership` (paid) · derive from 13F data already synced | Deriving from existing `fund_holdings` avoids a new vendor |

## C.2 Keys you already pay for / hold but do not use

| Key | Status | Opportunity |
|---|---|---|
| `FINNHUB_API_KEY` | ✅ Active, used for news/IPO/quote fallback | **Earnings calendar + analyst history — see C.3** |
| `TRADIER_ACCESS_TOKEN` | Service exists, **unwired** | Options chain greeks/IV/OI — the gap the Options screen fakes today |
| `BENZINGA_API_KEY` | Service exists, **unwired**; 403 on current plan | News importance, analyst actions |
| `UNUSUAL_WHALES_API_KEY` | Service exists, **unwired** | Options flow (marked Phase 2, not MVP) |
| `ANTHROPIC_API_KEY` | **Declared, zero references in `src/` — still true as of 2026-07-22** | Every "AI" feature in the app is currently a template string. The 2026-07-22 data wiring **did not touch this**; the gap is now proportionally larger, since the numbers beside the AI text became real while the text did not |
| `ALPHAVANTAGE_API_KEY` | Declared, unused | Backup for OHLCV/fundamentals |
| `MEDIASTACK_API_KEY` | Declared, unused | Backup news source |

## C.3 ⭐ Highest-value change available: switch the earnings calendar to Finnhub

Both endpoints probed live on 2026-07-20 with the **existing** `FINNHUB_API_KEY`:

| | FMP (current) | Finnhub |
|---|---|---|
| Rows, Jul 20–24 2026 | **10** | **488** |
| Rows, Wed Jul 22 | **2** | (within the 488) |
| Session (BMO/AMC) | ❌ absent | ✅ `hour`: `bmo`=138, `amc`=169, blank=181 |
| Fiscal quarter/year | ❌ | ✅ `quarter`, `year` |
| Revenue est/actual | ✅ | ✅ |

**What this unlocks:**
1. **~49× earnings coverage.** For reference, EarningSpike shows 389 companies for that week — Finnhub's 488 exceeds it; FMP's 10 is why our calendar looks empty.
2. **The Before Open / After Close filter**, which had to be omitted from the new earnings calendar because FMP carries no session field. ~63% of rows have a usable `hour`.
3. Fiscal quarter labelling.

**Cost:** none — the key is already provisioned and Finnhub is already a wired vendor with an existing adapter pattern to slot into.

**Caveat:** ~37% of rows have a blank `hour`. The UI must treat blank as "unspecified" rather than defaulting to a session, or it will fabricate exactly the kind of claim this document is auditing.

---

# Part D — Gaps, risks and recommended order of work

## D.1 Correctness bugs (wrong data shown, not just missing)

| # | Issue | Location | Impact |
|---|---|---|---|
| 1 | **AMD cross-contamination.** Detail card falls back to `EARN_CAL[0]` (AMD) for any ticker outside the ~33-row mock, rendering AMD's name/sector/guidance under the selected real symbol | `earnings.tsx:725` | **High** — actively wrong, and now easily reachable since the new calendar can select any live ticker |
| 2 | **"Import from photo"** claims AI image scanning; reads no image, returns a fixed 3-row result | `portfolio.tsx:145` | **High** — simulates a capability that does not exist |
| 3 | **"Schedule & share recap"** shows "✓ Recap scheduled" but performs no write and sends nothing | `settings.tsx:193` | **High** — same class of issue |
| 4 | **Nav clock** labeled "ET" but uses the browser's local timezone with no conversion | `shell.tsx:798` | Medium — wrong for any non-ET user. 🆕 **Half-fixed:** the *market-status pill* now converts correctly via `market-status.ts`; the clock beside it still does not. The correct helper exists in the codebase and is simply not called here |
| 🆕 10 | **US10Y tile showed the TLT ETF** — a bond fund that moves **inversely** to the yield it was labelled as, so rising yields rendered as a falling tile | `market-indices.job.ts` | **RESOLVED 2026-07-22** — now the real yield from `/fed/v1/treasury-yields`, `isProxy:false` |
| 🆕 11 | **Fear & Greed gauge** silently pinned at 62/"Greed" — `market_sentiment` had no Firestore rule, so default-deny blocked the read and the `?? 62` literal rendered instead | `firestore.rules`, `dashboard.tsx:344` | **RESOLVED 2026-07-22** — rule added. The `?? 62` fallback remains, so the same silent failure recurs if the job stops |
| 🆕 12 | **52-week high/low were `p × 0.58` / `p × 1.02`** — fixed multiples of the *current* price, so the "52-week range" tracked today's quote and "% from high" was a constant for every stock | `stock.tsx:671` | **RESOLVED 2026-07-22** — real `high52`/`low52`; widget gated on `has52w` |
| 🆕 13 | **Chart notes silently discarded** — `stock_comments` had no Firestore rule | `firestore.rules` | **RESOLVED 2026-07-22** — rule added |
| 5 | **EOD Recap** permanently renders "Tuesday, May 21" content as today's recap | `recap.tsx` | Medium |
| 6 | **AI Copilot** claims "Connected to your portfolio · live data"; replies are 4 cycled hardcoded strings | `shell.tsx:681` | Medium |
| 7 | Dashboard **"PDF" recap** downloads a one-line `.txt` | `dashboard.tsx:433` | Low |
| 8 | Heatmap **Stocks/S&P 500 tabs** are a dead control | `heatmap.tsx:116` | Low |
| 9 | Manage-Plan upgrade/billing buttons have **no handlers** | `manage-plan.tsx` | Low |

## D.2 Unlabeled fabrication (the systemic issue)

Only **three** places in the app label non-live data honestly: `ipos.tsx` ("· sample data"), `options.tsx` ("Simulated data…"), and `insider.tsx` ("the rest are illustrative sample data"). Everywhere else, fabricated values render identically to real ones.

The most-reused fabricators — 🆕 **status updated 2026-07-22**:

| Function | Location | Renders on | Status |
|---|---|---|---|
| `earnHistory()` | `utils.tsx:183` | Earnings, Stock, Commentary, every drawer chart, landing page | ⚠️ **partly superseded** — Stock #11/#16 now prefer `fin.epsHistory` and fall back to this; **Stock #5 (`EarnPane`), the Earnings Hub, Commentary and every drawer still call it directly.** Still the most-reused fabricator in the app |
| `genOHLC()` | `utils.tsx:310` | was: **all** charts in Screener/Watchlist/Portfolio/Themes; 1D/1W/5Y on Stock Detail | ✅ **superseded** by `useChartBars` — retained only as the empty-data fallback and on the landing page |
| `RsiPane` (internal walk) | `utils.tsx:502` | Stock Detail + every embedded chart | ✅ **superseded** — now takes `series={company.rsi14Series}`. It previously rendered a sine wave *beside a real RSI(14) number*, which is how the defect was found |
| `earnIncome()` | ×2 copies | Financial statements on Earnings + Stock | ⚠️ **partly superseded** — Stock (B.2 #10) now uses `financials`; **the Earnings Hub copy is untouched** |
| `divHistory()` | `macro.tsx:293` | Dividend history chart | ✅ **superseded** by `dividend_history` |
| `instMeta()` etc. | `insider.tsx:74` | Institutional tables and drawers | 🔴 **still live** |
| `buildChain()` | `options.tsx` | Options chain table | 🔴 **still live, and correctly so** — greeks/IV/OI are genuinely unavailable (A.1.0). Keep the "Simulated data" label |

🆕 **The systemic finding stands, but its shape changed.** Fabrication is no longer mostly *numeric* — it is now mostly *narrative*. Every "◆ AI" block in the app (Copilot, technical analysis, theme summary, watchlist summary, portfolio summary, earnings read, 13F summary, news briefing) is still a template string presented as generated analysis, and several make explicit false claims — the Copilot panel still says "Connected to your portfolio · live data". **Now that the numbers beside them are real, the AI text is the least defensible thing left on screen.**

⚠️ **A new sub-class of the same problem was introduced:** LIVE→fallback rows (§0). When the live field is null the old fabricated value renders with no visual difference — e.g. VWAP silently reverts to `p × 0.994`, the F&G gauge to `62`. This is strictly better than before (the fabrication is now the exception), but it is still unlabelled. Rendering "—" instead would close it out.

## D.3 Recommended order

**Original list (2026-07-20), with 2026-07-22 status:**

| # | Item | Status |
|---|---|---|
| 1 | Fix D.1 #1–#3 (AMD cross-contamination, fake photo import, fake recap scheduling) | 🔴 **not done** — all three still present |
| 2 | Switch earnings to Finnhub (C.3) | 🔴 **not done** — still FMP, still ~10 rows/week, still no session column |
| 3 | Label the rest — adopt `ipos.tsx`'s "· sample data" pattern app-wide | 🔴 **not done** |
| 4 | Wire Tradier for options greeks/IV/OI | 🔴 **not done** — and now confirmed as a genuine plan limit, so this is the only route |
| 5 | Migrate financials to SEC XBRL | 🔴 **not done** — and now **more** urgent (C.1) |
| 6 | Thread real bars through `stock-panel.tsx` | ✅ **DONE** — plus intraday, 5Y, RSI, MA/EMA, VWAP, 52-week, peers, dividends, financials |
| 7 | Decide on the "AI" features | 🔴 **not done** — `ANTHROPIC_API_KEY` still has zero references in `src/` |

**Revised order (2026-07-22).** Item 6 was completed and went considerably further than scoped; nothing else on the list moved. Two new blockers now outrank most of it:

1. 🆕 **Close §D.4 gap 1 — the browser cannot reach the backend.** This is the top item because it silently disables *already-written* code: the Monitor tab, extended-hours moves, the vendor market-status pill, and any future Stripe checkout. Note the trap: the fix (a Firebase Hosting rewrite → Cloud Run) **requires setting `ADMIN_GUARD_TRUST_IAM=false` first**, or `/sync/:job/run`, `/purge` and `/retention` become world-callable.
2. 🆕 **Close §D.4 gap 2 — create the Cloud Scheduler jobs.** No sync job has ever run automatically in production. Every improvement in this revision decays to stale data without it.
3. 🆕 **Rotate `POLYGON_API_KEY`** (§D.4 gap 3) — the current key was exposed.
4. **Fix D.1 #1–#3** (was #1) — still the cheapest credibility wins available.
5. **Switch earnings to Finnhub** (was #2) — still the biggest single data win, still free.
6. **Decide on the "AI" features** (was #7) — **promoted.** With the numeric layer now real, template strings labelled "AI-generated" are the most conspicuous remaining fabrication.
7. **Label what remains** (was #3) — including the new LIVE→fallback cases (§D.2).
8. **Migrate financials to SEC XBRL** (was #5) — urgency raised by this revision's added `/vX/` dependence.
9. **Wire Tradier** (was #4) — unchanged.

---

## 🆕 D.4 Production gaps — code that is written but does not run

Everything in this section is verified against the live Cloud Run revision (`market-catalyst-backend-00031-wvc`, us-central1, `--no-allow-unauthenticated`, `min-instances=0`) and Firebase Hosting (`https://marketcatalyst.web.app`, static export). **These are the difference between "wired" and "working".**

| # | Gap | Effect |
|---|---|---|
| 1 | 🔴 **The browser cannot reach the backend.** `NEXT_PUBLIC_BACKEND_URL` is unset, so `http://localhost:4400` is baked into the production bundle and blocked as mixed content from an HTTPS origin. | Disables in production: the admin **Monitor** tab, **extended-hours moves** (B.15 #5/#6), the **vendor market-status pill** overlay (B.20 #8), and any future Stripe checkout/webhook. Fix = Firebase Hosting rewrite → Cloud Run, which **requires** `ADMIN_GUARD_TRUST_IAM=false` first or `/sync/:job/run`, `/purge` and `/retention` become world-callable. |
| 2 | 🔴 **No Cloud Scheduler jobs exist in any region**, and no `scheduler-invoker` service account — `create-scheduler-jobs.sh` was never run. With `min-instances=0` the in-process `@Cron` decorators never fire. | **No sync job has ever run automatically in production.** All data in Firestore came from manual runs. Every cron in §A.7 describes intent, not observed behaviour. |
| 3 | 🔴 **`POLYGON_API_KEY` is un-rotated** (exposed in chat). Secret Manager version 4 is enabled. | `deploy/rotate-polygon-key.sh` automates everything except generating the replacement key. |
| 4 | 🔴 **Stripe is not implemented.** No Stripe code exists in either repo. | `payments` and `subscriptions` are empty; every revenue figure in the admin console reads 0. Checkout and webhooks are blocked on gap 1. |
| 5 | 🔴 **`api_usage` is specified but not implemented** — no middleware records API calls. | Admin "Usage & API" KPIs read 0. The `apiAccess` Pro entitlement grants access to something with no metering behind it. |
| 6 | 🔴 **Engagement columns are empty** — watchlists / holdings / apiCalls / alerts per user in the admin console. | No collection backs them; all read 0. |
| 7 | ⚠️ **Two `firestore.rules` files have drifted.** The live ruleset deploys from **`MarketCatalystUI/firestore.rules`**; the backend copy is stale and carries a DO-NOT-DEPLOY header. | Deploying the backend copy would re-break the F&G gauge and chart notes (D.1 #11/#13). |

**Populated collections (verified):** `intraday_bars` (474), `dividend_history` (241), `splits` (241), `plans` (3), `feature_adoption` (~12 seeded).
**Empty collections:** `payments`, `subscriptions`, `api_usage`, `audit_logs`, `revenue_summary`, `system_metrics`.

---

## 🆕 D.5 What is still fabricated or unavailable — the honest list

Read this before describing the app to anyone. The 2026-07-22 work moved the **numeric market-data layer**; it did not touch the following, and several items are structurally unavailable rather than merely unbuilt.

**Still fabricated (template strings / hardcoded arrays):**

- **Every AI narrative block** — Copilot (still claims "Connected to your portfolio · live data"), AI technical analysis, AI theme summary, AI watchlist summary, AI portfolio summary, AI earnings read, AI 13F summary, AI news briefing, AI cluster take.
- **Earnings estimates, guidance and session** (Before Open / After Close) — FMP carries no session field; the fix is Finnhub (§C.3), not done.
- **Analyst per-firm actions** — real firm names with invented ratings and price targets.
- **Institutional ownership %** and the institutional activity tables (`instMeta()`, `INST_DATA`).
- **Earnings transcripts** (`CALLS_DATA`, hand-authored).
- **EOD Recap** — the entire screen; still renders "Tuesday, May 21".
- **Options chain table** (`buildChain()`) — correctly labelled "Simulated data".
- **`earnHistory()` EPS/earnings panes** on the Earnings Hub, Commentary, every drawer, and Stock #5 — Stock #11/#16 are the only places now preferring real EPS.
- **`StockRow` sparklines** in `stock-panel.tsx`.
- **Nav clock "ET"** — browser-local time with an "ET" label.
- **"Import from photo"** and **"Schedule & share recap"** — both simulate actions they do not perform.

**Structurally unavailable on the current plan (no amount of wiring fixes these):**

| Item | Why |
|---|---|
| Options greeks, IV, open interest, bid/ask | 403 `NOT_AUTHORIZED` — needs the Options add-on or Tradier |
| Index values (`I:SPX`, `I:VIX`) | 403 — all index tiles remain ETF proxies (`isProxy:true`) |
| Trades / quotes / last-trade | 403 — 15-min delay is a hard floor |
| Short interest | 404 — needs FINRA files |
| Futures | 404 |
| History beyond 5 years | plan ceiling, enforced by `planHistoryFloor()` |
| Benzinga news importance, `/v1/summaries` | 403 |

**Built but not implemented behind the entitlement:**

- `backtesting`, `paperTrading` — granted on Pro, **not built**; correctly gated to "coming soon" by the FF_* release flags (§B.23).
- `alerts` — Plus entitlement, no alerts engine.
- `apiAccess` — Pro entitlement, no key issuance and no metering.
- Stripe / payments / billing portal — no code in either repo.

---

## D.6 Open items not covered here

- `MACRO_SERIES` (which FRED series IDs are synced) was not enumerated — read `src/common/macro-series.ts` to complete §A.4.
- The `sectorFromSic()` mapping table was not verified row by row.
- Production values of the `<NAME>_SOURCE` env vars are set in Cloud Run / Secret Manager and are **not** knowable from this repo — §A.6 shows `.env.example` values, which may differ from what is deployed.
- 🆕 The `market-breadth` job (18:30 ET → `market_breadth`) is synced but **no screen reads it yet**. It is the natural source for the Dashboard's Market Internals drawer (B.1 #17) and EOD Recap #10, both still static.
- 🆕 `intraday_bars` coverage was verified at **474 documents** (237 tickers × 2 resolutions), not the full ticker universe. Charts for tickers outside that set fall back to `genOHLC()`.
- 🆕 The `financials` collection's per-quarter depth and the `/vX/` field names above were read from `financials.job.ts`, not diffed against a live payload for every ticker.
- 🆕 `feature_adoption` currently holds ~12 seeded rows, so every adoption percentage in the admin console is **not yet meaningful**. Do not present those figures as product analytics.
