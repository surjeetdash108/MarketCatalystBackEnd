# Polygon Paid Plan → Feature Cross-Check

> ## ⏱ State sync — 2026-07-27 · TWO ENVIRONMENTS (stage + prod), env-driven config
>
> _This block is newest and authoritative where it differs from the blocks
> below. It introduces a second, fully-isolated environment; nothing about the
> per-environment runtime topology (§6, the on-demand data layer, the CDN
> rewrite) changes — that topology now simply exists twice, once per project._
>
> **This doc, specifically:** Polygon plan/endpoint findings are account-level,
> not per-environment — prod and stage share the same Polygon plan and keys via
> Secret Manager.
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
> **This doc, specifically:** For the crosscheck: 15 endpoints confirmed in use; annual financials added; snapshot / tape / collections are the cached serving endpoints.
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


**Generated:** 2026-07-21 · **Updated:** 2026-07-22 (backfill complete; statuses verified against production data)

**Method:** every row below was probed live against the app's own Polygon key (`api.massive.com`) on 2026-07-21. Nothing here is quoted from vendor documentation — `✅` means the endpoint returned `200` with real data, `❌` means it returned `403 NOT_AUTHORIZED` or `404`. Status values in §2.1 were read from production Firestore, not inferred from the code.

Companion to [FEATURE-DATA-MAP.md](./FEATURE-DATA-MAP.md) (what the app shows) and [WIDGET-PROVIDERS.md](./WIDGET-PROVIDERS.md) (who supplies it). **This file supersedes both where they disagree** — see §6 Corrections.

---

## 1. Verified plan entitlements

Plan: **Polygon Stocks Starter** (via Massive). Unlimited rate, 15-minute delayed, 5-year history.

### 1.1 REST — authorized ✅

| Endpoint | Result | Notes |
|---|---|---|
| `/v2/aggs/ticker/{sym}/range/1/day/{from}/{to}` | ✅ 200 | Daily OHLCV |
| `/v2/aggs/ticker/{sym}/range/{1,5}/minute/…` | ✅ 200 | **Intraday bars — 1553 one-minute bars returned; works ≥1 yr back** |
| `/v2/aggs/grouped/locale/us/market/stocks/{date}` | ✅ 200 | 12,411 tickers in one call |
| `/v2/aggs/ticker/{sym}/prev` · `/v1/open-close/{sym}/{date}` | ✅ 200 | |
| `/v2/snapshot/locale/us/markets/stocks/{tickers,gainers,losers}` | ✅ 200 | Delayed snapshot |
| `/v3/snapshot?ticker.any_of=` | ✅ 200 | **Carries `early_trading_change_percent` + `late_trading_change_percent`** |
| `/v3/reference/tickers` · `/tickers/{sym}` | ✅ 200 | Universe + profile |
| `/vX/reference/financials?timeframe=quarterly` | ✅ 200 | Income stmt + balance sheet + cash flow |
| `/v1/related-companies/{sym}` | ✅ 200 | Real peers (AAPL → MSFT, AMZN, GOOGL, NVDA…) |
| `/v3/reference/dividends` · `/splits` | ✅ 200 | Full history, date-ranged |
| `/vX/reference/ipos` | ✅ 200 | |
| `/vX/reference/tickers/{sym}/events` | ✅ 200 | Ticker/name changes |
| `/v2/reference/news` | ✅ 200 | |
| `/v1/indicators/{rsi,macd,sma,ema}/{sym}` | ✅ 200 | Vendor-computed indicators |
| `/v1/marketstatus/{now,upcoming}` | ✅ 200 | Live session state + holiday calendar |
| `/v3/reference/{exchanges,conditions,tickers/types}` | ✅ 200 | |
| `/v3/reference/options/contracts` | ✅ 200 | Contract **reference only** |
| `/v2/aggs/ticker/O:{contract}/range/1/day/…` | ✅ 200 | **Per-contract OHLCV bars work** |
| `/fed/v1/treasury-yields` | ✅ 200 | 1M–30Y curve, back to 1962 |
| `/fed/v1/inflation` · `/inflation-expectations` | ✅ 200 | CPI + model expectations |
| `/v2/aggs/ticker/C:{pair}/prev` | ✅ 200 | FX aggregates |

### 1.2 REST — NOT authorized ❌

| Endpoint | Result | Consequence |
|---|---|---|
| `/v3/snapshot/options/{underlying}` | ❌ 403 | **No greeks, no IV, no OI, no bid/ask** |
| `/v3/snapshot/options/{u}/{contract}` | ❌ 403 | same |
| `/v2/last/trade/{sym}` · `/v2/last/trade/O:{c}` | ❌ 403 | No last-trade print |
| `/v3/trades/{sym}` | ❌ 403 | No tick data |
| `/v3/quotes/{sym}` | ❌ 403 | No NBBO / bid-ask |
| `/v3/snapshot/indices?ticker=I:SPX` | ❌ 403 | **No index values** |
| `/v2/aggs/ticker/I:SPX` · `I:VIX` | ❌ 403 | **No SPX / NDX / DJI / RUT / VIX spot** |
| `/v1/summaries` | ❌ 403 | |
| `/benzinga/v1/analyst-insights` | ❌ 403 | No analyst insights |
| `/benzinga/v1/ratings` · `/firms` | ❌ 403 | **No per-firm upgrades/downgrades/PT** |
| `/benzinga/v1/earnings` · `/guidance` | ❌ 403 | **No earnings session/guidance** |
| `/benzinga/v1/news` | ❌ 403 | |
| `/stocks/vX/short-interest` · `/short-volume` | ❌ 404 | Not served on this host at all |
| `/futures/vX/products` | ❌ 404 | No WTI / GOLD futures |

### 1.3 Measured limits

| Limit | Measured value | How |
|---|---|---|
| **Data delay** | **exactly 900 s = 15.0 min** | snapshot `updated` ts vs wall clock, market open |
| **Daily history depth** | **exactly 5 years rolling** | `2021-07-22` → ✅ 200 · `2021-07-01` → ❌ 403 (today = 2026-07-21) |
| **Intraday history depth** | **≥ 4 years** | 1-min bars ✅ at 2022-07-01, 2023-07-03, 2024-07-01 |
| Rate limit | none hit | `POLYGON_PAGE_DELAY_MS=0` |

### 1.4 WebSocket (from [LIVE-PRICE-EVAL.md](./LIVE-PRICE-EVAL.md), probed 2026-07-20)

| Cluster / channel | Result |
|---|---|
| `wss://socket.polygon.io/stocks` (real-time) | ❌ "You don't have access real-time data" |
| `wss://delayed.polygon.io/stocks` — `A` (per-second aggs) | ✅ authorized |
| `wss://delayed.polygon.io/stocks` — `AM` (per-minute aggs) | ✅ authorized |
| `wss://delayed.polygon.io/stocks` — `T` (trades) | ❌ not authorized |
| `wss://delayed.polygon.io/stocks` — `Q` (quotes) | ❌ not authorized |

---

## 2. Features that **WILL** work on the paid Polygon plan

Everything in this section is achievable with the current subscription — no new vendor, no upgrade.

> **Status means "is it real *right now*", not "is it built".** Shipping code only means the *next* run of a job produces real values; until that job has covered the ticker universe the UI still renders its fallback, silently. Conflating the two is how a feature gets reported as done while every user still sees fabricated numbers — so every ✅ below was read back out of production Firestore, not inferred from the code. The 2026-07-22 backfill closed all of them except items 12 and 13, which are blocked on §2.2.

### 2.1 Every feature this plan serves

One table, grouped by domain, covering both what already worked and the 18 items wired on 2026-07-21. The **#** column carries the implementation item number (referenced from §5 and §7); a dash means it predates this pass. Every fabricated path is retained as a fallback for tickers a job has not reached, so nothing goes blank for a symbol outside the synced universe.

**Status:** ✅ live in production (counts are tickers covered, of 241) · ⚠ works locally but not in production · ➖ no stored data involved

| # | Feature | Screen | Served by | Status |
|---|---|---|---|---|
| **Prices & charts** |||||
| — | Live price ticker / quote header | Shell, Stock | `/v2/snapshot/…/tickers` | ✅ |
| — | Delayed live stream (SSE) | Stock (Search) | `wss://delayed…` channel `A`/`AM` | ✅ |
| — | Price chart 3M / 6M / 1Y | Stock | `/v2/aggs/…/1/day` → `ohlcv_bars` | ✅ |
| 1 | 1D / 1W / 1M charts *(were `genOHLC` synthetic)* | Stock + 4 panels | `intraday-bars.job.ts` → `useChartBars.ts` | ✅ 474 docs, ~395k bars |
| 2 | 5Y chart *(was synthetic)* | Stock + 4 panels | `stock-history.job.ts`, backfill 300 d → 5 y | ✅ 299,552 bars |
| 11 | Charts on Watchlist / Portfolio / Themes / Screener *(100% synthetic — `ChartCard` never passed `realBars`)* | those 4 screens | `stock-panel.tsx` | ➖ reads item 2's bars |
| 5 | VWAP *(was `p * 0.994`)* | Stock | vendor `vw` persisted per bar | ✅ 241/241 |
| 12 | Premarket / After-hours moves *(were hardcoded lines)* | Commentary | `/v3/snapshot` → `useExtendedHours.ts` | ⚠ local only — see §2.2 |
| **Indicators & rankings** |||||
| — | RS Rating, Tech Rating, RSI/MACD/SMA scalars | Screener, Stock | computed from `ohlcv_bars` | ✅ |
| 3 | RSI pane series *(was a seeded sine walk)* | Stock + panels | `technical-indicators.job.ts` → `RsiPane series=` | ✅ 241/241 |
| 4 | MA/EMA ladder, 10/20/30/50/100/200 *(were price multiples)* | Stock | `technical-indicators.job.ts` → `MA_LADDER_ROWS` | ✅ 241/241 |
| 9 | 52-week high/low *(were `p * 0.58` … `p * 1.02`)* | Stock | `technical-indicators.job.ts` | ✅ 241/241 |
| 10 | Avg volume *(was market cap ÷ price × constant)* | Stock | `technical-indicators.job.ts` | ✅ 241/241 |
| **Company & fundamentals** |||||
| — | Company header, profile, market cap, sector | Stock, Screener | `/v3/reference/tickers/{sym}` | ✅ |
| — | Quarterly financials (10 quarters) | Stock, Earnings | `/vX/reference/financials` | ✅ |
| 6 | Peers list *(was a sector-filtered mock)* | Stock | `/v1/related-companies/{sym}` | ✅ 225/241 — see §2.4 |
| 18 | Balance sheet + cash flow *(were fabricated)* | Stock, Earnings | `financials.job.ts` — same call, fields were discarded | ✅ 226 tickers |
| **Dividends & corporate actions** |||||
| — | Dividends calendar (ex / pay / amount) | Macro | `/v3/reference/dividends` | ✅ |
| 7 | Dividend history card + drawer *(10 yr extrapolated)* | Stock, Macro | `corporate-actions.job.ts` → `useDividendHistory.ts` | ✅ 241/241 |
| 8 | Dividend yield *(null → "n/a")* | Stock, Macro | TTM sum ÷ price; annualized per calendar row | ✅ 176/241 — see §2.4 |
| 16 | Splits *(never synced)* | *data only — no UI consumer yet* | `corporate-actions.job.ts` | ✅ 241/241 |
| **Market-wide** |||||
| — | Market Movers (gainers / losers) | Movers, Dashboard | `/v2/snapshot/…/gainers`,`/losers` | ✅ |
| — | Sector heatmap (11 SPDR ETFs) | Heatmap | ETF daily aggs | ✅ |
| — | Market indices strip *(ETF proxies — see §3.1)* | Shell, Dashboard | ETF daily aggs | ✅ |
| — | Fear & Greed + Market Internals | Dashboard | `/v2/aggs/grouped/…` | ✅ |
| 13 | Market-status pill *(was a local clock + hand-kept holiday list)* | Shell (all screens) | `GET /live/market-status` | ⚠ local only — see §2.2 |
| 14 | US 10Y tile *(was **TLT — an ETF that moves inversely to the yield it was labelled as**)* | Shell, Dashboard, Macro | `/fed/v1/treasury-yields` | ✅ real yield 4.60%, `isProxy:false` |
| **News, IPOs & options** |||||
| — | News feed + bell | Commentary, Dashboard | `/v2/reference/news` | ✅ |
| — | IPO calendar | IPOs | `/vX/reference/ipos` | ✅ |
| — | Options **reference** chain (strike / expiry) | Options | `/v3/reference/options/contracts` | ✅ |
| 15 | IPO aftermarket performance | IPOs | `ipos.job.ts` — *already implemented before this pass* | ✅ |
| 17 | Options per-contract OHLCV *(close + volume only)* | Options | `options-chains.job.ts` — O/H/L/C, VWAP, trade count | ✅ 8 underlyings |

**New Firestore collections:** `intraday_bars`, `dividend_history`, `splits`.
**New jobs:** `intraday-bars` (16:25 ET weekdays), `corporate-actions` (06:40 ET daily).
**New endpoint:** `GET /live/market-status`.

**Deployed 2026-07-21:** Cloud Run revision `market-catalyst-backend-00030-8p5`; Hosting release to `marketcatalyst.web.app`; Firestore rules released. Health, job registry (26) and `/live/market-status` verified on the live revision.

### 2.2 The browser cannot reach the backend in production ⚠

Items 12 and 13 are the only two features here served by an HTTP endpoint rather than Firestore, and **neither works in production today.**

`NEXT_PUBLIC_BACKEND_URL` is unset, so all four backend callers — `market-status.ts`, `useSnapshotQuote`, `useLiveQuote`, `useExtendedHours` — fall back to their `http://localhost:4100` default, and that literal is baked into the exported static bundle. On an HTTPS Hosting origin a plain-HTTP `localhost` request is blocked as mixed content before it leaves the browser. Both call sites catch the failure and degrade quietly — the pill falls back to the local-clock computation, the extended-hours strip renders nothing — so there is no visible error, which is exactly why this needed checking rather than assuming.

This predates the current work (`useSnapshotQuote` and `useLiveQuote` have always had it); items 12 and 13 simply inherit it.

**Closing it is a security decision, not a config tweak.** Cloud Run runs `--no-allow-unauthenticated`, and `AdminGuard` relies on that: with `ADMIN_GUARD_TRUST_IAM=true`, a request with no `Authorization` header is treated as pre-vetted by Cloud Run IAM. Making the service browser-reachable **must** be paired with `ADMIN_GUARD_TRUST_IAM=false`, or `/sync/:job/run`, `/purge` and `/retention` become world-callable. The guard's own docblock says so. Options, in rough order of preference:

1. **Firebase Hosting rewrite → Cloud Run.** Keeps one origin (no CORS), but the rewrite invokes the service as the Hosting service account, so the guard must stop trusting header-less requests.
2. **Make the service public + flip `ADMIN_GUARD_TRUST_IAM=false`** so only a verified Firebase admin token passes, and add CORS for the Hosting origin.
3. **Leave it.** Items 12 and 13 stay on their fallbacks; everything else in §2.1 reads Firestore directly and is unaffected.

### 2.3 Backfill state and how to check it

Raising the backfill depth was not sufficient on its own. `sync_watermarks.lastSyncedThrough` only ever moves **forward**, so an already-synced ticker asks for `watermark + 1 day` and never reaches newly-available older history — the 5Y chart would have stayed synthetic while every build and test passed. `stock-history.job.ts` now also tracks `earliestSyncedFrom` and fills **backwards** to the plan edge; see §6.

Measured on the first deep run: **74,647 bars across 60 tickers in 11m36s** (~1,244 each). Spot check afterwards:

```
MSFT   bars=1252   2021-07-26 → 2026-07-21   vwap on 1252/1252   ← deep-filled
AAPL   bars= 205   2025-09-23 → 2026-07-17   vwap on 0/205       ← cursor not yet reached
```

Cursor-batched jobs cover 241 tickers at 40–60 per run, so full coverage needed 4–7 runs each. **The full sequence completed 2026-07-22 in ~2h20m**, run in dependency order (bars → intraday → companies → corporate-actions → indicators → statements), because the later jobs derive from the earlier ones' output.

| Phase | Result |
|---|---|
| stock-history × 4 | 224,905 bars → `ohlcv_bars` now **299,552 docs** |
| intraday-bars × 7 | 474 docs, ~395,000 bars |
| companies × 5 | 294 written; 4 failed on an **FMP 429 rate limit** (fallback path only — Polygon is primary) |
| corporate-actions × 7 | 280 dividend docs + 280 split docs |
| technical-indicators / rs-rating / tech-rating | 241 each, 0 skipped |
| financials × 7 | 262 written, 18 failed |
| dividends / market-indices / options-chains | 1,067 · 9 · 8 |

To re-check later: count documents per collection and confirm a ticker's oldest bar sits near `planHistoryFloor()` (today − 5 years).

**Verification performed:** every new vendor method probed against the live key; 15 unit tests cover the RSI series and dividend year-boundary math (`sync-derivations.spec.ts`), including the invariant that `rsiSeries` ends exactly where the scalar `rsi()` lands; session slicing checked against real bars from four viewer timezones. Post-sync spot check on MSFT: price 398.64 inside a 52-week range of 349.20–555.45, VWAP 399.30, SMA-200 438.16, 90-point RSI series, 300 bars analysed, 1,263 five-minute bars.

### 2.4 Two coverage gaps that are correct, not failures

**Peers: 225/241.** The 16 empty ones are ALNY, ANGI, BABA, BIDU, GEN, GL, GOOS, JD, LIN, NIO, PDD, SAP, TM, TSM, YELP, ZIM — predominantly foreign issuers and ADRs, for which `/v1/related-companies` simply returns nothing. A vendor coverage limit, not a sync error. The UI falls back to the sector-filtered list for these.

**Dividend yield: 176/241.** The 65 nulls split into two legitimate groups:

- **57 genuine non-payers** — no dividend history at all.
- **8 lapsed payers** — real history, but zero payments in the trailing twelve months: ADBE (last ex-date 2005-03-24), ADSK (2005-03-22), INTC (2024-08-07, suspended), MELI (2017-12-28), PARA (2025-06-16), PDD (2010-08-16), S (2005-03-02), STLA (2025-04-23). A trailing-twelve-month yield for these is correctly null, not zero-filled.

That second group exposed a bug in the first cut of the UI, since fixed: `isPayer` means "has any dividend history", **not** "pays today". Gating the card on it left `yieldPct` null, which then fell through to the static mock — so Adobe rendered a fabricated current yield beside its genuine but twenty-year-old payment rows. Once real dividend data exists it is now treated as authoritative *including when the answer is "nothing"*, and a lapsed payer shows "Dividend suspended" with its last payment date rather than borrowing the mock's number.

---

## 3. Features that **WILL NOT** work with Polygon

Split by *why*, because the remedy differs.

### 3.1 Hard plan block — Polygon has the product, this tier doesn't include it

| Feature | Screen | Blocking probe | Remedy |
|---|---|---|---|
| **Options chain: IV, open interest, bid/ask** | Options (main table, `buildChain`) | `/v3/snapshot/options/AAPL` → 403 | **Tradier** (token already held) or Polygon **Options Starter** add-on |
| **Options greeks** (delta/gamma/theta/vega) | Options drawer | same 403 | same |
| **Options-implied move** | Earnings, Dashboard earnings pop | needs IV → same 403 | same |
| **SPX / NDX / DJI / RUT index values** | Shell strip, Dashboard Market Pulse | `/v2/aggs/I:SPX` → 403 | Polygon **Indices** add-on; today ETF proxies (SPY/QQQ/DIA/IWM) |
| **VIX spot** | Dashboard VIX card, Macro VIX card | `/v2/aggs/I:VIX` → 403 | Indices add-on; today the VIXY ETN proxy, labelled as such in the UI |
| **Real-time (non-delayed) prices** | everywhere | RT socket → "no access"; REST delay measured 900 s | Polygon real-time tier; **note the UI currently *displays* the 15-min lag as a feature** |
| **Tick / trade prints, NBBO, bid-ask spread** | — (not rendered today) | `/v3/trades`,`/v3/quotes` → 403 | Advanced tier |
| **Per-firm analyst upgrades/downgrades/PT** | Analyst (main table), Dashboard Analyst Actions, Commentary news-history | `/benzinga/v1/ratings` → 403 | Polygon **Benzinga add-on**, or Benzinga direct, or FMP/Finnhub (consensus/history only, *not* per-firm) |
| **Earnings session BMO/AMC** | Earnings, Earnings Calendar, Dashboard | `/benzinga/v1/earnings` → 403 | **Finnhub `/calendar/earnings` — free, key already held** |
| **Earnings guidance (Raised/In-line/Lowered)** | Earnings detail card | `/benzinga/v1/guidance` → 403 | Benzinga-class feed |

### 3.2 Polygon has no such product at all

| Feature | Screen | Correct source |
|---|---|---|
| **Earnings calendar / estimates** | Earnings Calendar, Dashboard | Finnhub ✅ (already keyed) / FMP |
| **Analyst consensus counts** | Stock Tech Rating, Analyst | FMP `/grades-consensus` ✅ (wired) |
| **Forward FY EPS estimate, beat/miss streak** | Stock earnings card | FMP / Finnhub |
| **Short interest %** | Stock keystats + insider card | FINRA bi-monthly files (free) — Polygon returns 404 on all short-interest paths |
| **Institutional ownership % / owner counts / QoQ** | Insider 13F tab (`instMeta` hash-fabricated) | SEC 13F — derive from already-synced `fund_holdings` |
| **Insider Form 4 detail** | Insider tab | SEC EDGAR ✅ (already wired) |
| **13F manager names, top holding, new/exit counts** | Insider fund cards | SEC EDGAR filings (parse deeper) |
| **Earnings-call transcripts + audio** | Earnings `CallDrawer` | FMP paid add-on / API Ninjas |
| **Macro consensus estimates** (→ beat/miss) | Macro econ calendar | Not FRED either — needs Trading Economics / Econoday class |
| **NYSE TICK, McClellan Osc, put/call ratio** | Dashboard internals drawer | CBOE (put/call) / exchange feeds; A/D + up-down volume already computed |
| **52W new-high / new-low counts** | Dashboard internals | Derivable in-house from `grouped-daily` ✅ |
| **WTI / GOLD / DXY** | Shell strip | `/futures/…` 404; use commodity ETFs (USO/GLD/UUP) via existing agg calls |
| **Sector / theme constituent membership** | Heatmap, Themes | Static config — reasonable to keep |
| **Company bios, catalyst narratives** | Earnings, Movers | Editorial / LLM |

### 3.3 Not a data problem — no vendor solves these

All **AI narrative** surfaces: *What Matters Now*, every "◆ AI …" block (technical analysis, earnings read, dividend read, portfolio/watchlist/theme summaries, 13F summary), Recap headlines + news-briefing tweets, *Before the Bell* / *After the Close*, earnings-call AI summaries, 30-/60-sec audio, and portfolio "import from photo" OCR.

→ These need **Anthropic** (`ANTHROPIC_API_KEY` is provisioned, zero refs in code). Deferred by decision on 2026-07-21.

---

## 4. Per-screen verdict

| Screen | Polygon-servable | Needs another vendor | Verdict |
|---|---|---|---|
| **Dashboard** | Movers, heatmap, portfolio/watchlist prices, F&G, internals, VIX *(proxy)* | Earnings session, analyst per-firm, AI card, insider | 🟡 mostly Polygon; 3 gaps |
| **Stock detail** | Charts (all 7 timeframes once intraday+5Y synced), financials, peers, dividends, pivots, RSI/MACD/MA, 52W | Analyst counts, EPS estimates, short int %, inst. own %, AI blocks | 🟢 **biggest upside** — items 1–11 in §2.1 all land here |
| **Movers** | Price, %chg, volume, RVOL, 5-day %, sector, cap, intraday spark | Catalyst attribution | 🟢 fully servable |
| **Heatmap** | Cap, day %, week %, RVOL, RS, MA status | Sector membership (static, fine) | 🟢 fully servable |
| **Screener** | RS, tech rating, growth/margin, cap, RVOL, above-50/200-DMA | — | 🟢 fully servable |
| **Macro** | Dividends (+ real yield & 10-yr history), 10Y curve, CPI | VIX spot, econ consensus est., beta/IV30 for VIX-sensitive table | 🟡 dividends fully fixable |
| **IPOs** | Calendar, offer price, **aftermarket performance** | Upcoming S-1 pipeline | 🟡 perf gap is derivable |
| **Commentary** | News feed, premarket/after-hours moves | Analyst PT in news-history, AI blocks | 🟡 |
| **Earnings / Earnings Calendar** | Financials, EPS actuals, post-print reaction *(computable from bars)* | Estimates, session, guidance, implied move, transcripts | 🔴 **mostly non-Polygon** |
| **Analyst** | — | Per-firm events (Benzinga-class) — consensus only today | 🔴 **vendor-blocked** |
| **Insider** | — | SEC EDGAR (already wired); inst. % + short int. fabricated | 🔴 **not a Polygon domain** |
| **Options** | Contract reference, per-contract OHLCV | IV, OI, bid/ask, greeks | 🔴 **plan-blocked** |
| **Portfolio / Watchlist / Themes** | Prices, %chg, charts *(once `realBars` is passed through)* | Cost basis (user), AI summaries | 🟢 servable |
| **Recap** | Index %, sector %, movers, internals | AI headlines/narrative | 🔴 **AI-blocked**, data layer is ready |

---

## 5. What this means in one table

| Bucket | Count | Examples |
|---|---|---|
| ✅ **Working on Polygon paid before this pass** | ~14 feature areas | charts 3M–1Y, movers, heatmap, news, dividends, IPOs, financials, F&G |
| ✅ **Newly wired 2026-07-21, backfilled 2026-07-22** (§2.1) | **18 items** | intraday + 5Y charts, real RSI, peers, dividend history & yield, VWAP, 52W, premarket/AH moves, market status, 10Y |
| 🔴 **Plan-blocked** (Polygon sells it, tier excludes it) | 9 | options IV/OI/bid-ask/greeks, SPX/VIX spot, real-time, ticks, per-firm analyst, earnings session/guidance |
| 🔴 **Polygon has no product** | 13 | earnings estimates, short interest, inst. ownership, transcripts, macro consensus, TICK/McClellan/put-call |
| 🔴 **Needs an LLM, not a data vendor** | all AI surfaces | What Matters Now, every ◆ AI block, recaps, audio |

**The single highest-leverage finding:** items 1, 2 and 11 in §2.1. Every chart outside `stock.tsx` was synthetic *not because the data was unavailable but because `ChartCard` never passed `realBars`* — and intraday + 5-year bars, previously believed plan-blocked, both return 200 on the current subscription.

**What did NOT change:** the plan itself. §3's blocks are unaffected — nothing in this pass bought an entitlement. Options greeks/IV/OI, index spot values, real-time prices and per-firm analyst actions remain unavailable, and the VIX/SPX tiles remain ETF proxies.

---

## 6. Corrections to existing repo docs

| Doc | Claim | Correction |
|---|---|---|
| `DELIVERY-PLAN-STATUS.md` R24 | "1D/1W charts need intraday bars; 5Y needs 5yr history — those timeframes still synthetic" | **Both are authorized on the current plan.** 1-min aggs returned 1,553 bars; daily aggs reach exactly 5 years back. This is a **sync gap, not a plan gap** — R24 is unblockable today with no purchase. |
| `FEATURE-DATA-MAP.md` §A.1.2 | `peers` "structurally null on this source — Polygon has no such product" | Wrong. `/v1/related-companies/{sym}` returns real peers on this plan. |
| `FEATURE-DATA-MAP.md` §A.1.2 | `dividendYield` structurally null | Not vendor-blocked — derivable from `/v3/reference/dividends` + price. |
| `WIDGET-PROVIDERS.md` §1 | Options chain "no greeks/IV/OI" | Correct, **and** per-contract *OHLCV bars* (`/v2/aggs/ticker/O:{c}`) do work — usable for last/volume even without the snapshot. |
| `WIDGET-PROVIDERS.md` §6 | Polygon paid "does NOT cover … news importance" | Restated precisely: Polygon's own `/v2/reference/news` ✅ works; it's the **Benzinga-sourced** `/benzinga/v1/news` that 403s. |
| — | *(new)* | Polygon's `/fed/v1/*` economic endpoints (treasury yields, CPI, inflation expectations) are **authorized** and unused. |
| — | *(new)* | `/v3/snapshot` exposes **extended-hours** change %, unblocking the premarket/after-hours cards. |
| — | *(new, found while implementing)* | **Raising a backfill constant does nothing on its own.** `sync_watermarks.lastSyncedThrough` only advances forward, so an already-synced ticker requests `watermark + 1 day` and never reaches newly-available older history. `stock-history.job.ts` now tracks `earliestSyncedFrom` and fills backwards too. Any future depth increase must do the same — otherwise it type-checks, tests green, runs clean, and silently changes nothing. |
| — | *(new, found while implementing)* | Only **one** composite index exists on `ohlcv_bars` — `(ticker ASC, barDate DESC)`. An `orderBy('barDate','asc')` query fails with `FAILED_PRECONDITION`. Read newest-first and reverse in memory; do not add an ASC orderBy without deploying an index for it. |

---

## 7. Recommended sequence

1. ~~**No-purchase, high-yield (do first):** §2.1 items 11 → 1 → 2 → 3 → 6 → 7.~~ **Done 2026-07-21** — code complete, backfill running.
2. ~~**No-purchase, cheap:** items 5, 8, 9, 10, 12, 13, 15.~~ **Done 2026-07-21.**
3. ~~**Finish the backfill.**~~ **Done 2026-07-22** — see §2.3.
4. **Then decide on purchases**, in descending value:
   - **Finnhub earnings** (free, key held) → session BMO/AMC, 49× calendar coverage.
   - **Tradier** (token held, unwired) → options IV/OI/bid-ask, closes R32.
   - **Benzinga-class feed** (Polygon add-on *or* Benzinga direct) → closes R41 + R42 guidance.
   - **Polygon Indices add-on** → real SPX/NDX/DJI/RUT/VIX, retires every `isProxy` label.
5. **Separately:** wire Anthropic (R34) — nothing in §3.3 moves until then.

---

## 8. Security note

`POLYGON_API_KEY` is present in plaintext in `.env` and was previously pasted into chat. `DELIVERY-PLAN-STATUS.md` R49 flags it as still un-rotated. **Rotate it** — every probe in this document was run with the live key.

Status as of 2026-07-21: **still un-rotated.** Secret Manager has version `4` enabled (the exposed key); versions 1–3 are already disabled.

[`deploy/rotate-polygon-key.sh`](../deploy/rotate-polygon-key.sh) automates everything except the one step that requires signing in to the vendor dashboard — generating the replacement key, which you must do yourself. The script reads the new key with `read -rs` so it is never echoed, never enters shell history, and never appears in `ps`; it verifies the key works **and still carries the paid entitlements** before changing anything, then adds the secret version, updates `.env`, redeploys, and disables the old version last.

Two things worth knowing before running it:

- The redeploy is **mandatory**. Cloud Run resolves `--set-secrets …:latest` when the *revision is created*, not per request, so adding a secret version alone changes nothing in production.
- The final step — revoking the old key in the Massive/Polygon dashboard — is manual. Until it is done the exposed key still works against your account and quota.
