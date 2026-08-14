# Widgets → Data Providers

> ## ⏱ State sync — 2026-07-27 · TWO ENVIRONMENTS (stage + prod), env-driven config
>
> _This block is newest and authoritative where it differs from the blocks
> below. It introduces a second, fully-isolated environment; nothing about the
> per-environment runtime topology (§6, the on-demand data layer, the CDN
> rewrite) changes — that topology now simply exists twice, once per project._
>
> **This doc, specifically:** Widget-to-provider mappings are unaffected — this
> is a deploy-topology change, not a data-source change.
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
> **This doc, specifically:** For widgets: index tiles / drawer / Market Pulse are consistent and live; the sector modal is real; TradingView is removed.
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


**Generated:** 2026-07-21 · **Updated:** 2026-07-22 (Polygon wiring shipped; several rows below were wrong and are corrected) · Companion to the exhaustive [FEATURE-DATA-MAP.md](./FEATURE-DATA-MAP.md).

Each widget maps to its **current provider** with an arrow. `A → B` means A is primary, B is the fallback. Endpoints marked ✅ were called live on the app's own keys (2026-07-20/21); alternatives are ⚠️ from vendor docs unless marked ✅.

> **[POLYGON-FEATURE-CROSSCHECK.md](./POLYGON-FEATURE-CROSSCHECK.md) is authoritative on Polygon entitlements** — every endpoint there was probed live against the app's own key. Where this file and that one ever disagree, that one wins. Three claims previously made here were **wrong** and are corrected below: Polygon *does* have a peers product, dividend yield is *not* structurally null, and the options limitation is narrower than stated (per-contract OHLCV works; only the snapshot 403s). See §7.

---

## Legend

```
Widget  ──►  Provider            = current data source
A → B                            = primary → fallback chain in code
✅                               = verified live against the endpoint
⚠️                               = from vendor docs, NOT tested — verify before relying
```

---

## 1. Widgets backed by a real API

| Widget | Current provider | Current endpoint | Alternative provider → endpoint |
|---|---|---|---|
| **Earnings Calendar** | ──► **FMP** ⚠️ *(10 rows/wk)* | `GET /stable/earnings-calendar?from=&to=` ✅ | **Finnhub** → `GET /api/v1/calendar/earnings?from=&to=` ✅ *(488 rows + BMO/AMC)* |
| **Live price ticker** | ──► **Polygon** | `GET /v2/snapshot/locale/us/markets/stocks/tickers?tickers=` ✅ | Finnhub → `GET /api/v1/quote?symbol=` ✅ · Twelve Data → `/quote` ⚠️ |
| **Price chart — 3M/6M/1Y/5Y** | ──► **Polygon** | `GET /v2/aggs/ticker/{sym}/range/1/day/{from}/{to}` ✅ *(backfill now 5 years, the plan's rolling edge — was ~300 days)* | Stooq → CSV ⚠️ · Tiingo → `/tiingo/daily/{sym}/prices` ⚠️ · Twelve Data → `/time_series` ⚠️ |
| **Price chart — 1D/1W/1M (intraday)** *(new)* | ──► **Polygon** | `GET /v2/aggs/ticker/{sym}/range/{5,30}/minute/…` ✅ → `intraday_bars` | — *these were believed plan-blocked; they are not* |
| **Peers list** *(new — see §7.1)* | ──► **Polygon** *(sector-filtered list as fallback)* | `GET /v1/related-companies/{sym}` ✅ | FMP → `/stable/stock-peers` ⚠️ |
| **Dividend history + yield** *(new)* | ──► **Polygon** *(yield derived in-house)* | `GET /v3/reference/dividends?ticker=&limit=1000` ✅ → `dividend_history`; yield = TTM sum ÷ price | FMP → `/stable/dividends-calendar` ✅ *(carries a yield field directly)* |
| **Split history** *(new)* | ──► **Polygon** | `GET /v3/reference/splits?ticker=` ✅ → `splits` | FMP ⚠️ |
| **Financial statements** *(balance sheet + cash flow)* | ──► **Polygon** | `GET /vX/reference/financials?ticker=&timeframe=quarterly` ✅ | SEC XBRL → `/api/xbrl/companyconcept/…` ⚠️ *(free, avoids the experimental `/vX/` namespace)* |
| **Market open/closed pill** *(new)* | ──► **Polygon** | `GET /v1/marketstatus/{now,upcoming}` ✅ *(via backend `GET /live/market-status`)* | — *previously a local clock + hand-kept holiday list* |
| **Premarket / after-hours moves** *(new)* | ──► **Polygon** | `GET /v3/snapshot?ticker.any_of=` ✅ — carries `early_trading_change_percent` / `late_trading_change_percent` | — *the v2 snapshot has no extended-hours fields; this is why the cache moved v2 → v3* |
| **US 10-year Treasury yield** *(new — see §7.3)* | ──► **Polygon** | `GET /fed/v1/treasury-yields` ✅ *(1M–30Y curve, back to 1962)* | FRED → `/fred/series/observations?series_id=DGS10` ✅ |
| **Company header / profile** | ──► **Polygon → FMP** | `GET /v3/reference/tickers/{sym}` ✅ | Finnhub → `GET /api/v1/stock/profile2?symbol=` ⚠️ |
| **Market Movers** | ──► **FMP → Polygon** | `GET /stable/biggest-gainers` ✅ *(⚠️ no volume)* | Polygon → `GET /v2/snapshot/locale/us/markets/stocks/gainers` ✅ *(has volume)* |
| **Market Indices / VIX strip** | ──► **Polygon → Finnhub** | `GET /v2/aggs/ticker/{etf}/range/1/day/…` ✅ — **ETF proxies** (SPY/QQQ/DIA/IWM/VIXY, `isProxy:true`), because index spot `I:SPX`/`I:VIX` is 403 on this plan. **US10Y is the exception and is no longer a proxy** — see §7.3 | Finnhub → `/api/v1/quote` ✅ · CBOE → delayed quotes ⚠️ · Polygon **Indices add-on** for real spot |
| **Sector Heatmap** | ──► **Polygon (11 SPDR ETFs) → FMP** | ETF quotes / `GET /stable/sector-performance-snapshot?date=` ✅ | FMP is the stronger source here |
| **News feed + bell** | ──► **Polygon + Finnhub** *(merged)* | `GET /v2/reference/news?ticker=` ✅ + `GET /api/v1/company-news?symbol=` ✅ | Marketaux → `/v1/news/all` ⚠️ · GDELT → `/api/v2/doc/doc` ⚠️ *(no key)* |
| **Analyst consensus** | ──► **FMP** *(snapshot only)* | `GET /stable/grades-consensus?symbol=` ✅ | **Finnhub** → `GET /api/v1/stock/recommendation?symbol=` ✅ *(monthly history)* |
| **Dividends calendar** | ──► **Polygon → FMP** | `GET /v3/reference/dividends?ex_dividend_date.gte=` ✅ | FMP → `/stable/dividends-calendar` ✅ *(adds yield)* · Finnhub → `/api/v1/stock/dividend` ⚠️ |
| **IPO calendar** | ──► **Polygon → Finnhub** | `GET /vX/reference/ipos?listing_date.gte=` ✅ | Finnhub → `GET /api/v1/calendar/ipo` ✅ |
| **Options chain (Live Reference)** | ──► **Polygon** *(contract reference **+ per-contract OHLCV**; no greeks/IV/OI — see §7.2)* | `GET /v3/reference/options/contracts?underlying_ticker=` ✅ **and** `GET /v2/aggs/ticker/O:{contract}/range/1/day/…` ✅ *(O/H/L/C, VWAP, trade count)* | **Tradier** → `GET /v1/markets/options/chains` ⚠️ *(token provisioned, unwired)* · Alpaca → `/v1beta1/options/…` ⚠️ |
| **Economic calendar** | ──► **FRED** | `GET /fred/series/observations?series_id=` ✅ | — *free & authoritative; keep* |
| **Insider (Form 4)** | ──► **SEC EDGAR** | `GET /submissions/CIK{cik}.json` ✅ | — *free & authoritative; keep* |
| **Institutional (13F)** | ──► **SEC EDGAR** | `GET /submissions/CIK{cik}.json` → filing XML ✅ | — *free & authoritative; keep* |
| **Fear & Greed gauge** | ──► **Polygon** *(computed in-house)* | `GET /v2/aggs/grouped/locale/us/market/stocks/{date}` ✅ | CNN → unofficial endpoint ⚠️ *(keep in-house)* |
| **RS Rating** | ──► *none — computed* | from `ohlcv_bars` in Firestore | — *own IBD-style calculation* |
| **Technical indicators (RSI/MACD)** | ──► *none — computed* | from `ohlcv_bars` in Firestore | Polygon `GET /v1/indicators/{rsi,macd,sma,ema}/{sym}` ✅ *(authorized; in-house is cheaper — keep)* |
| **RSI pane series, MA/EMA ladder, VWAP, 52W range, avg volume** *(new)* | ──► *none — computed* | `technical-indicators.job.ts` from `ohlcv_bars` → `companies`; VWAP is the vendor's own `vw` persisted per bar | — *all five were fabricated from the price before this pass* |
| **Feature adoption analytics** *(new)* | ──► *none — first-party* | client writes `feature_adoption/{uid}_{feature}` directly | — *the browser has no backend route, so this is client-written by necessity* |
| **Plans & entitlements** *(new)* | ──► *none — first-party* | `plans` collection, seeded from `plans.registry.ts` | Stripe — **planned, not integrated**; see the vendor tracker |

---

## 2. Widgets with NO real API today *(fabricated in the browser)*

Six rows that were here on 2026-07-21 have since been wired and moved to §1: charts in Screener/Watchlist/Portfolio/Themes, financial statements, the RSI pane, peers, dividend history, and the 10-year yield tile. What remains:

| Widget | Current | ──► should point to |
|---|---|---|
| **EPS-surprise / pivot panes** | `earnHistory()` | compute from `ohlcv_bars` ✅ *(the RSI pane in this group is done — 90-point rolling series, 241/241)* |
| **AI Copilot / AI summaries** | 4 hardcoded strings / templates | **Anthropic** → `POST /v1/messages` ⚠️ *(ANTHROPIC_API_KEY provisioned, still zero refs in code)* |
| **Earnings-call transcripts** | hand-written `CALLS_DATA` | FMP → `/stable/earning-call-transcript` ⚠️ *(paid)* · API Ninjas ⚠️ |
| **EOD Recap** | 100% static ("Tuesday, May 21") | `market_indices` + `news` + Anthropic — the data layer is ready; the narrative is the blocker |
| **VIX card (Macro screen)** | hardcoded `14.18` | `market_indices` VIXY ✅ *(already synced; Dashboard's VIX card uses it)* — a proxy, and labelled as one; real VIX spot needs the Indices add-on |
| **Institutional ownership tables** | `instMeta()` hash-fabricated | derive from `fund_holdings` ✅ *(already synced)* |
| **Options chain bid/ask, IV, OI, greeks** | `buildChain()` seeded PRNG | **Tradier** ⚠️ *(token held)* or Polygon Options Starter — genuinely plan-blocked, not merely unwired. *Last* and *volume* are the two columns now fillable from the per-contract aggregates in §1 |
| **Short interest %, insider ownership %** | static maps | FINRA bi-monthly files ⚠️ *(free)* — Polygon 404s on every short-interest path |
| **Payments / subscriptions / revenue** *(admin console)* | suppressed on real data | **Stripe — planned, not integrated.** No Stripe code exists in either repo; the fabricated MRR history chart and trend deltas are now hidden rather than shown against real users |

---

## 3. Base URLs

| Provider | Base URL | Auth |
|---|---|---|
| Polygon / Massive | `https://api.massive.com` | `?apiKey=` |
| FMP | `https://financialmodelingprep.com/stable` | `?apikey=` |
| Finnhub | `https://finnhub.io/api/v1` | `?token=` |
| FRED | `https://api.stlouisfed.org/fred` | `?api_key=` |
| SEC EDGAR | `https://data.sec.gov` + `https://www.sec.gov` | none *(User-Agent header required)* |
| SEC XBRL | `https://data.sec.gov/api/xbrl` | none |
| Tradier | `https://api.tradier.com` | `Bearer` token |
| Anthropic | `https://api.anthropic.com` | `x-api-key` |

---

## 4. The three highest-value swaps

| # | Widget | Change | Why | Cost |
|---|---|---|---|---|
| 1 | Earnings Calendar | FMP ──► **Finnhub** | 49× coverage (10 → 488 rows) + BMO/AMC session field | free — key already held |
| 2 | Options chain | Polygon ──► **Tradier** | real greeks / IV / open interest vs Polygon's none | token already provisioned |
| 3 | ~~Financial statements~~ | ~~`earnIncome()` fabricated ──► **SEC XBRL**~~ | **Done 2026-07-22 on Polygon instead** — `/vX/reference/financials` already returned balance sheet and cash flow; the job was fetching and discarding them. SEC XBRL remains the option if the experimental `/vX/` namespace ever becomes a concern | free |

---

## 5. Keys held but unused

| Key | Status | Opportunity |
|---|---|---|
| `TRADIER_ACCESS_TOKEN` | provisioned, unwired | options greeks/IV/OI (swap #2) |
| `ANTHROPIC_API_KEY` | declared, zero refs in code | every "AI" widget is a template string today |
| `BENZINGA_API_KEY` | 403 on current plan | news importance, per-firm analyst actions |
| `ALPHAVANTAGE_API_KEY` | declared, unused | backup OHLCV / fundamentals |
| `MEDIASTACK_API_KEY` | declared, unused | backup news |

---

## 6. Can every static widget go dynamic? — and does Polygon *paid* already cover it?

All probed live against the paid Polygon (Stocks Starter) key on **2026-07-21**. "Polygon paid?" = does your current plan return the data, tested — not assumed. Measured alongside: **exactly 900 s (15 min) delay** and **exactly a 5-year rolling history window**. As of 2026-07-22 every ✅ row below is not merely *available* but **wired and backfilled** — see [POLYGON-FEATURE-CROSSCHECK.md](./POLYGON-FEATURE-CROSSCHECK.md) §2.1 for per-ticker coverage counts.

### Fabricated / static widgets → the API that fixes them

| Widget (currently fabricated) | Can go dynamic? | Best source | On Polygon **paid**? | Endpoint |
|---|---|---|---|---|
| Charts in Screener/Watchlist/Portfolio/Themes (`genOHLC`) | ✅ yes | Polygon | ✅ **yes** *(already synced to `ohlcv_bars`)* | `GET /v2/aggs/ticker/{sym}/range/1/day/{from}/{to}` ✅ |
| Financial statements (`earnIncome`) | ✅ yes | Polygon | ✅ **yes** — full income stmt, balance sheet, cash flow | `GET /vX/reference/financials?ticker=&timeframe=quarterly` ✅ |
| RSI / MACD / SMA panes (sine wave) | ✅ yes | Polygon | ✅ **yes** — dedicated indicator endpoints | `GET /v1/indicators/{rsi,macd,sma}/{sym}` ✅ *(also computed in-house from bars)* |
| Peers list (fabricated "change") | ✅ yes | Polygon | ✅ **yes** — returns real peer tickers | `GET /v1/related-companies/{sym}` ✅ *(e.g. AAPL → MSFT, AMZN, GOOGL, NVDA…)* |
| Dividend-history chart (`divHistory`) | ✅ yes | Polygon | ✅ **yes** — full history, date-ranged | `GET /v3/reference/dividends?ticker=&limit=1000` ✅ |
| Institutional ownership tables (`instMeta`) | ✅ yes | SEC EDGAR | ➖ n/a — derive from synced `fund_holdings` | already in Firestore ✅ |
| Insider ownership % / short interest (static maps) | ⚠️ partial | FINRA / SEC | ❌ not Polygon paid | FINRA short-interest files (free) ⚠️ |
| Earnings calendar (mock `EARN_CAL`) | ✅ yes | Finnhub | ❌ not Polygon *(no earnings product)* | `GET /api/v1/calendar/earnings` ✅ |
| Analyst ratings / clusters (mock `analyst`) | ✅ yes | FMP / Finnhub | ❌ not Polygon | FMP `/stable/grades-consensus` ✅ · Finnhub `/stock/recommendation` ✅ |
| **Options chain greeks / IV / OI / bid-ask** (`buildChain`) | ✅ yes | **Tradier** | ❌ **NOT on Polygon paid** — `/v3/snapshot/options/{u}` → 403 `NOT_AUTHORIZED`. **But scope this precisely: the *snapshot* is blocked, not the contract.** `/v3/reference/options/contracts` and per-contract aggregates `/v2/aggs/ticker/O:{c}/range/1/day/…` both return 200, so strike, expiry, last and volume are all servable today — only greeks, IV, OI and bid/ask are not | Tradier `GET /v1/markets/options/chains` ⚠️ |
| **Splits history** | ✅ yes | Polygon | ✅ **yes** | `GET /v3/reference/splits?ticker=` ✅ *(wired 2026-07-22 → `splits`)* |
| **Intraday charts (1D/1W/1M)** | ✅ yes | Polygon | ✅ **yes** — previously assumed blocked | `GET /v2/aggs/ticker/{sym}/range/{5,30}/minute/…` ✅ *(≥4 years of intraday depth)* |
| **Market open/closed + holiday calendar** | ✅ yes | Polygon | ✅ **yes** | `GET /v1/marketstatus/{now,upcoming}` ✅ |
| **Premarket / after-hours change %** | ✅ yes | Polygon | ✅ **yes** | `GET /v3/snapshot` ✅ — v2 has no extended-hours fields |
| **US 10Y yield / CPI / inflation expectations** | ✅ yes | Polygon | ✅ **yes** — a whole authorized namespace that was unused | `GET /fed/v1/{treasury-yields,inflation,inflation-expectations}` ✅ |
| **SPX / NDX / DJI / RUT / VIX spot** | ⚠️ proxy only | Polygon Indices add-on | ❌ **not on Polygon paid** — `/v2/aggs/I:SPX`, `I:VIX` → 403 | today SPY/QQQ/DIA/IWM/VIXY ETF proxies, labelled `isProxy:true` |
| AI Copilot / AI summaries (hardcoded) | ✅ yes | Anthropic | ❌ not a market-data vendor | `POST /v1/messages` ⚠️ *(key provisioned, unused)* |
| Earnings-call transcripts (`CALLS_DATA`) | ✅ yes | FMP (paid add-on) | ❌ not Polygon | FMP `/stable/earning-call-transcript` ⚠️ |
| EOD Recap (100% static) | ✅ yes | synced data + Anthropic | ➖ narrative needs Anthropic; numbers already synced | `market_indices` + `news` ✅ |
| VIX card on Macro (hardcoded `14.18`) | ✅ yes | Polygon | ✅ **yes** *(already synced as VIXY)* | `market_indices` doc ✅ |

### Verdict

- **Nearly every static widget can go dynamic.** The only ones with no free/current path are earnings-call transcripts (paid) and the "AI" widgets (need Anthropic).
- **Polygon paid covered far more than the app used** — and as of 2026-07-22 that gap is closed. What was "confirmed working but not wired" (peers, full financial statements, intraday aggregates, dividends/splits history, `/fed/v1/*`, `/v1/marketstatus/*`, `/v3/snapshot`) is now wired and backfilled. The technical-indicator endpoints remain deliberately unused — the in-house computation from `ohlcv_bars` is cheaper and already correct.
- **Polygon paid does NOT cover:** options greeks/IV/OI/bid-ask (`403` on the snapshot only), index spot values (`I:SPX`, `I:VIX`), real-time prices (delayed-only, measured at exactly 900 s), tick trades/quotes, earnings calendar, analyst ratings, and the entire `/benzinga/v1/*` namespace. Those need Finnhub / FMP / Tradier / SEC / an add-on as noted.
- **Nothing in this pass bought an entitlement.** Every gain came from calling endpoints the plan already served.

---

## 7. Corrections to earlier notes in this repo

These are wrong claims that were previously stated as fact here or in sibling docs. All four were disproven by live probes, not by re-reading vendor documentation.

1. **Polygon *does* have a peers product.** `GET /v1/related-companies/{ticker}` works on the paid plan and returns real tickers (AAPL → MSFT, AMZN, GOOGL, NVDA…). This file's §1 and FEATURE-DATA-MAP §A.1.2 both stated peers are "structurally null on Polygon" — a vendor-capability claim that was never tested. The `companies` job simply never called the endpoint. Now wired: **225/241 covered**; the 16 blanks are foreign issuers and ADRs the endpoint genuinely returns nothing for, which is a coverage limit rather than a failure, and those fall back to the sector-filtered list.

2. **`dividendYield` is not "structurally null" either.** Correct that Polygon exposes no *yield field* — incorrect that the yield is therefore unavailable. It is **derivable**: TTM sum of `/v3/reference/dividends` ÷ price, annualized per calendar row. Now populated for **176/241**, and the 65 nulls are correct answers rather than gaps — 57 genuine non-payers plus 8 lapsed payers whose last payment predates the trailing twelve months. That second group exposed a real bug: `isPayer` means "has any dividend history", **not** "pays today", so gating on it left the yield null and fell through to the static mock — Adobe rendered a fabricated current yield beside genuine but twenty-year-old payment rows. Real dividend data is now authoritative *including when the answer is "nothing"*.

3. **The US10Y tile was a TLT ETF proxy — and TLT moves *inversely* to the yield it was labelled as.** This was worse than a stale number: the sign was wrong, so the tile reported falling yields as rising. It is now the real Treasury yield from `/fed/v1/treasury-yields`, with `isProxy:false` and `unit:"percent"`. The remaining strip tiles (SPX/NDX/DJI/RUT/VIX/WTI/GOLD/DXY) are still ETF proxies and still labelled as such — index spot 403s and futures 404 on this plan.

4. **The options limitation is narrower than "no greeks/IV/OI" implied.** Per-contract **OHLCV bars** (`/v2/aggs/ticker/O:{contract}/range/1/day/…`) return 200 and are now synced with full O/H/L/C, VWAP, trade count and range %. Only the options *snapshot* 403s, so the unavailable set is exactly: greeks, IV, open interest, bid/ask.

5. **"Polygon paid does not cover news importance" was imprecise.** Polygon's own `/v2/reference/news` ✅ works and is in use; it is the **Benzinga-sourced** `/benzinga/v1/news` that 403s, along with the rest of that namespace (ratings, firms, earnings, guidance, analyst-insights).

6. **Polygon paid exposes RSI/MACD/SMA/EMA indicator endpoints.** The app computes these in-house from `ohlcv_bars` instead — fine and cheaper, but the vendor path exists if ever wanted.

### New Polygon endpoints now in use

| Endpoint | Purpose | Status |
|---|---|---|
| `GET /fed/v1/treasury-yields` | Real US 10Y yield, replacing the TLT proxy | ✅ 200 · wired |
| `GET /v1/marketstatus/{now,upcoming}` | Market open/closed pill + holiday calendar | ✅ 200 · wired *(backend-served; unreachable from the production browser)* |
| `GET /v3/snapshot?ticker.any_of=` | Universal snapshot — extended-hours change %, market status | ✅ 200 · wired *(replaced the v2 snapshot cache)* |
| `GET /v3/reference/splits?ticker=` | Split history → `splits` | ✅ 200 · wired |
| `GET /v1/related-companies/{sym}` | Real peers | ✅ 200 · wired |
| `GET /v2/aggs/ticker/{sym}/range/{5,30}/minute/…` | Intraday bars → `intraday_bars` | ✅ 200 · wired |
| `GET /v2/aggs/ticker/O:{contract}/range/1/day/…` | Per-contract options OHLCV | ✅ 200 · wired |
| `GET /fed/v1/{inflation,inflation-expectations}` | CPI + model expectations | ✅ 200 · **authorized but still unused** |
