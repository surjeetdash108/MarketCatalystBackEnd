# Market Intelligence Platform — API Vendor Tracker

> ## ⏱ State sync — 2026-08-16 · FMP NEWS LIVE + full-US earnings (deployed to prod)
>
> _Newest block; authoritative where it differs from the blocks below. It records
> the first FMP feed that **reaches users**, and corrects the 2026-08-03
> vendor-key audit for FMP specifically._
>
> **FMP news is now IN SCOPE and LIVE in prod.** Previously FMP was worker-only
> and "never served to the browser" (2026-07-24 block). That is no longer true
> for news: the news feed now **merges Polygon + FMP** articles, deduped by URL
> (**Polygon wins** a collision). Wiring: `FmpService.getStockNews()` →
> `/stable/news/stock`; `src/adapters/fmp-news.adapter.ts` + `NEWS_FMP_ADAPTER`
> token; env **`NEWS_FMP_SOURCE=fmp`**; merge loop in `news.job.ts`; `/live/news`
> on-demand path (`ondemand.service.ts`) also writes `vendor`. Every article now
> carries `vendor` (`"polygon"`|`"fmp"`), badged in the UI (`commentary.tsx`,
> `stock.tsx`) alongside publisher `source` + `sentiment`.
> · ⚠ **Redistribution licensing** for serving FMP news was flagged and
>   **accepted by the user** — a deliberate exception to Polygon-only-to-users.
> · ⚠ FMP article `sentiment` is **frequently null**.
>
> **`FMP_API_KEY` is now funded in prod.** The 2026-08-03 audit found it
> present-but-empty in the local `.env`; news working in prod confirms the key is
> populated in the runtime environment (Secret Manager via ADC). The R41/R42/R47
> "data-dead" caveat in the 2026-08-03 block is therefore lifted for prod.
>
> **Earnings calendar is now full-US.** The FMP **forward** earnings calendar no
> longer filters to the ~385 tracked `companies`. `earnings.job.ts`
> (`loadRefNames`) resolves every FMP calendar symbol against the ~13,106-row
> Polygon US ticker reference (`tickers` collection, written by
> `ticker-universe.job`), keeping CS/ADRC US listings (Polygon names) and dropping
> FMP's worldwide rows. Reported/historical rows were already full-US (Polygon
> `getFinancialsByFilingDate`). `earnings_events` total ~7.3k → ~8.8k.
> See `FMP-INTEGRATION.md` §3 (Tier 1C + Tier 1A full-US note).

> ## ⏱ State sync — 2026-08-03 · VENDOR-KEY AUDIT (only Polygon is funded in the inspected `.env`)
>
> _Read alongside the 2026-07-27 block below: keys are supposed to come from
> **Secret Manager via ADC**, so the local `.env` is not the production source of
> truth. But the `.env` inspected on 2026-08-03 has **only `POLYGON_API_KEY` set**
> (len 32) — `FMP_API_KEY`, `FINNHUB_API_KEY`, `FRED_API_KEY`, `BENZINGA_API_KEY`,
> `TRADIER_ACCESS_TOKEN`, `UNUSUAL_WHALES_API_KEY` and `ANTHROPIC_API_KEY` are all
> **present-as-name but EMPTY** (values never printed; audited by length)._
>
> **Why it matters for this tracker.** Every §2 requirement whose Primary/Fallback
> vendor is FMP, Finnhub, Benzinga, Tradier, UnusualWhales or Anthropic will
> return **nothing at runtime** unless the corresponding key is populated in the
> environment the backend actually runs in. Concretely this makes the interim
> feeds for **R41** (FMP analyst consensus), **R42** (FMP earnings calendar),
> **R47** (FMP earnings side) and **R29**'s estimate join **data-dead right now**,
> and it means the "token/key already provisioned" notes for **Tradier (R32)** and
> **Finnhub (R42)** in the delivery tracker are **not** true in this `.env`.
>
> **Action (do not assume prod is broken):** confirm each key against **prod
> Secret Manager**. If a key is set there, the runtime is fine and only the local
> `.env` is empty — annotate accordingly. If it is unset in prod too, fund the key
> (or accept the gap and keep the dependent rows honestly labeled). Tracked as
> **O6** in `DELIVERY-PLAN-STATUS.md`. Note also: the 2026-08-02 request to move
> **Analyst Actions** from FMP to **Polygon** is **not yet implemented** — no
> Polygon analyst/ratings endpoint is wired (`PolygonService` has no such method),
> so Analyst Actions still resolves from FMP consensus.

> ## ⏱ State sync — 2026-07-27 · TWO ENVIRONMENTS (stage + prod), env-driven config
>
> _This block is newest and authoritative where it differs from the blocks
> below. It introduces a second, fully-isolated environment; nothing about the
> per-environment runtime topology (§6, the on-demand data layer, the CDN
> rewrite) changes — that topology now simply exists twice, once per project._
>
> **This doc, specifically:** Vendor coverage is unchanged — stage's
> `backend-runtime` service account reads the same Secret Manager keys via ADC
> as prod, so vendor access is identical once stage's backend deploys.
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
> **This doc, specifically:** For vendors: Polygon-only to users; 15 endpoints in use; FMP/Finnhub worker-only; Alpha Vantage evaluated and rejected on redistribution.
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


v1.0 | June 2026

> **⚠ Drifted from implementation (updated 2026-07-09, first noted
> 2026-07-05):** Several schemas below (`analyst_actions`, `earnings_events`,
> `news`, `market_movers`, etc.) were planned with richer fields than what's
> actually implemented — e.g. `analyst_actions` was planned as a per-event
> upgrade/downgrade feed but is actually a Buy/Hold/Sell consensus-vote
> snapshot today (FMP `grades-consensus`, not Benzinga). `news` has drifted
> the other way — Polygon (primary as of 2026-07-08) actually exceeds what
> was originally planned, adding per-ticker sentiment/reasoning/keywords
> neither the original plan nor Finnhub (the fallback) carry. The vendor
> cost/tier tables in §1-3 below are still a reasonable reference for vendor
> selection and pricing, but for the actual field-level schema and which
> vendor is really wired per collection today, see `Doc/openapi.yaml`
> (authoritative, kept in sync with `backend/src/sync/*.job.ts` and
> `backend/src/adapters/`) and `Doc/schema.sql`.
>
> **Addendum 2026-07-22.** The Polygon plan's actual entitlements have now been
> probed endpoint-by-endpoint against the live key — see the new §2.1 below and
> [POLYGON-FEATURE-CROSSCHECK.md](./POLYGON-FEATURE-CROSSCHECK.md), which is
> **authoritative on what Polygon does and does not serve** and supersedes the
> vendor-capability guesses in §1–§3. Several assumptions in this file were
> wrong in the app's favour (intraday aggregates, 5-year history, peers,
> dividends/splits history and the `/fed/v1/*` macro namespace are all
> authorized and were simply never called) and one was wrong against it
> (Polygon serves no index spot values, so the SPX/VIX tiles are ETF proxies).
>
> **Addendum 2026-07-23 — "wire Polygon everywhere it can be" audit.** Swept the
> app for any place a *non-Polygon* vendor is used where Polygon has an
> equivalent on the current plan. **Result: none to swap.** Every price / bar /
> snapshot / company / news / dividend / split / IPO / financials / market-status
> / sector / mover path is already Polygon. The remaining non-Polygon vendors are
> used *only* where Polygon has **no product** on Stocks Starter:
> **FMP** (earnings calendar + analyst consensus) and **Finnhub** (EPS estimate
> backfill) → Benzinga add-on territory (R41/R42); **FRED** (macro economic
> series — CPI/unemployment/payrolls/GDP/… — US-government public data;
> Polygon's `/fed/v1/*` only covers treasury yields + inflation, not the rest).
> **SEC EDGAR** (13F/Form 4) is public-domain. So the vendor split is already
> Polygon-first, with non-Polygon only where Polygon offers nothing.
>
> Also 2026-07-23: **Search, Watchlist and Portfolio** were switched from the
> once-a-day EOD price on `companies` to **live delayed prices** via the shared
> `/live/snapshot` endpoint (`useSnapshotQuotes`), so ticker prices — and the
> portfolio total (Σ shares×price) — now move intraday. Polygon `/v3/snapshot`
> backs it; one upstream call per refresh regardless of user count.
> **Stripe has also been added to §1 as a PLANNED vendor — it is not
> integrated; no Stripe code exists in either repo.**

---

## 1. Vendor Overview

| Vendor | Free Tier | Paid Pricing (est.) | Category | Startup-Friendly |
|---|---|---|---|---|
| **Polygon.io** (now Massive) | 5 req/min, 15-min delayed REST only | ~$29/mo Starter (real-time + WebSocket) | Quotes, OHLCV, Block Trades | ✅ Yes |
| **Finnhub** | 60 req/min, WebSocket (50 symbols), quotes + news + calendar | $11.99–$99.99/mo | Quotes, News, Macro, Fundamentals | ✅ Yes — free tier covers MVP basics |
| **Twelve Data** | 8 req/min, 800/day, US equities | $29/mo Grow, $99/mo Pro | OHLCV historical, indices | ✅ Yes |
| **Benzinga** | Basic news headlines only (AWS Marketplace free tier) | Custom pricing ~$149–299/mo (contact sales) | News, Analyst Actions, Earnings, Transcripts | ⚠️ Paid required for full API |
| **Financial Modeling Prep (FMP)** | 250 req/day, 5yr financials | $99–399/mo (contact for current tiers) | Earnings Calendar, Fundamentals, Sector, Analyst, Transcripts | ✅ Yes |
| **Unusual Whales** | Website only (no free API) | $48/mo standard; API Advanced plan for WebSocket streaming | Options Flow, Dark Pool, Congressional Trades | ✅ Yes |
| **SEC EDGAR** | 100% free (10 req/sec rate limit) | Free | 13F Filings, All SEC Filings | ✅ Free |
| **Tradier** | Free API access with free brokerage account | $10/mo Pro, $35/mo Pro Plus | Options Chains, Real-time Quotes, Paper Trading | ✅ Yes — free option |
| **Trading Economics** | Very limited (no API on free) | ~$150+/mo | Macro/Economic Calendar | ⚠️ Expensive for data volume |
| **Intrinio** | 14-day trial only | $150–$1,600/mo per dataset | Transcripts, Options, Fundamentals, Real-time | ⚠️ Expensive — use as fallback |
| **Motley Fool Transcripts API** | None | $2,000+/year (enterprise) | Earnings Transcripts | ❌ Not startup-friendly |
| **Refinitiv (LSEG)** | None | Enterprise contract only ($5k+/mo) | Full market data | ❌ Enterprise only |
| **Market Chameleon** | Website research tool only | No public API | Options research | ❌ No usable API |
| **Stripe** *(PLANNED — not integrated)* | No monthly fee | 2.9% + 30¢ per successful card charge (standard US pricing) | Payments, Subscriptions, Billing | ✅ Yes — pay-per-transaction |

### 1.1 Stripe — planned, NOT integrated

Listed here so the intent is recorded, **not** because anything is wired. State as of 2026-07-22, verified by searching both repos:

- **No Stripe code exists in either repo.** No SDK dependency, no API key, no checkout session, no webhook handler, no customer or price objects.
- The `payments` and `subscriptions` Firestore collections exist and are **empty**, because nothing writes to them.
- `users.stripeCustomerId` / `stripeSubId` appear in the §5.16 schema below as forward-looking fields only; they are null on every document.
- The `plans` collection (3 plans, seeded from `plans.registry.ts`) is real and live, and the entitlement layer that reads it works — but plan assignment is currently manual. Amounts are stored in **minor units** (`4999` = $49.99), which is Stripe's own convention, so the data is shaped for an eventual integration.
- **Integration is blocked on a prerequisite**, not just on effort: the browser cannot reach the backend in production (`NEXT_PUBLIC_BACKEND_URL` is unset, so `http://localhost:4400` is baked into the static bundle and blocked as mixed content). Checkout redirects and webhook confirmation both require a reachable backend origin.
- Consequently the admin console's Revenue and Subscriptions views read zero. The console's fabricated MRR history chart and trend deltas are **suppressed** when running against real data rather than carried forward, since invented revenue figures shown beside real users would read as authoritative.

---

## 2. Data Requirement → Recommended Vendor

| Data Requirement | Primary Vendor | Fallback | Free Option Available | Notes |
|---|---|---|---|---|
| Real-time quotes (WebSocket) | Polygon.io (Paid) | Finnhub (Free, 50 symbols) | ✅ Finnhub free tier | Polygon WebSocket needs paid plan |
| OHLCV historical data | Polygon.io (Paid) | Twelve Data (Free/Paid) | ✅ Twelve Data 800/day free | Backfill 2yr on first run |
| Indices (S&P, Nasdaq, Dow, etc.) | Polygon.io | Finnhub | ✅ Finnhub free | Index quotes via same WS connection |
| News and headlines | **Polygon** (primary) + **FMP** (merged, wired 2026-08-16) | Finnhub (Free) | ✅ | LIVE in prod: `news.job.ts` merges Polygon `/v2/reference/news` + FMP `/stable/news/stock` (`getStockNews()`, `fmp-news.adapter.ts`, `NEWS_FMP_SOURCE=fmp`), deduped by URL (**Polygon wins**), each article badged `vendor`. FMP redistribution flagged + accepted; FMP `sentiment` often null. |
| Earnings calendar + actuals | FMP (Paid) | Benzinga | ❌ Free tiers too limited | FMP has best earnings calendar coverage. **Full-US since 2026-08-16:** forward FMP calendar resolved against the Polygon `tickers` reference (not just the ~385 tracked `companies`); reported rows already full-US via Polygon. |
| Earnings transcripts | FMP (Paid — included in plan) | Intrinio ($250+/mo) | ❌ No free option | FMP includes transcripts on paid plans; avoid Motley Fool/Refinitiv |
| Analyst ratings + targets | Benzinga (Paid) | FMP (Paid) | ❌ No meaningful free tier | Benzinga has real-time ratings stream |
| 13F filings | SEC EDGAR (Free) | — | ✅ Completely free | Rate limit: 10 req/sec; parse XML directly |
| Macro/economic calendar | Finnhub (Free tier sufficient) | FMP | ✅ Finnhub free tier | Finnhub economic calendar free on all plans |
| Options chain (calls + puts, IV, OI) | Tradier (Free) | Polygon.io Options REST | ✅ Tradier free with brokerage account | Powers Options Chain screen `/menu/options` |
| Options flow + unusual activity | Unusual Whales (Paid) | Tradier (options chains, free) | ⚠️ Tradier free for chains only | Unusual Whales needed for "unusual" flow detection |
| Block trade data | Polygon.io (Paid — same subscription) | Intrinio | ❌ Needs paid | Polygon Trades API covers block detection |
| Company reference + fundamentals | **Polygon** (migrated 2026-07-12) | FMP (Paid) | ✅ Polygon free tier | Polygon `/v3/reference/tickers` + `/vX/reference/financials` (TTM EPS → computed P/E). FMP fallback still the only source for peers, beta, dividend yield. |
| Sector and industry group data | **Polygon** (migrated 2026-07-12) | FMP (Paid) | ✅ Polygon free tier | 11 SPDR sector-ETF proxies, day-over-day % (proxy, not cap-weighted). FMP snapshot as fallback. |
| Dividends calendar | **Polygon** (migrated 2026-07-12) | FMP (Paid) | ✅ Polygon free tier | Polygon `/v3/reference/dividends`. No yield field on Polygon (null; present only via FMP fallback). |
| IPO calendar | **Polygon** (migrated 2026-07-12) | Finnhub (Free) | ✅ Polygon free tier | Polygon `/vX/reference/ipos` by listing_date. FMP's ipos-calendar restricted. |
| Intraday bars (1D/1W/1M charts) | **Polygon** (wired 2026-07-22) | — | ❌ paid plan | `/v2/aggs/ticker/{sym}/range/{5,30}/minute/…`. Previously assumed plan-blocked; it is not. ≥4 years of intraday depth measured. |
| Dividend payment history + yield | **Polygon** (wired 2026-07-22) | FMP (Paid) | ❌ paid plan | `/v3/reference/dividends`. **Corrects the row above:** Polygon has no yield *field*, but yield is *derivable* (TTM sum ÷ price) — it is not vendor-blocked. |
| Split history | **Polygon** (wired 2026-07-22) | — | ❌ paid plan | `/v3/reference/splits`. Never synced before this pass. |
| Peers / related companies | **Polygon** (wired 2026-07-22) | FMP (Paid) | ❌ paid plan | `/v1/related-companies/{sym}`. **Corrects the "peers" note on the Company reference row above** — Polygon does have this product; it was simply never called. 225/241 covered; blanks are foreign issuers and ADRs. |
| Treasury yields / CPI / inflation expectations | **Polygon** (wired 2026-07-22) | FRED (Free) | ✅ FRED free | `/fed/v1/treasury-yields` powers the real US10Y tile, replacing a **TLT ETF proxy that moved inversely to the yield it was labelled as**. `/fed/v1/inflation*` authorized but unused. |
| Market open/closed state + holiday calendar | **Polygon** (wired 2026-07-22) | — | ❌ paid plan | `/v1/marketstatus/{now,upcoming}`, replacing a local clock and a hand-maintained holiday list. |
| Extended-hours (pre/post) change % | **Polygon** (wired 2026-07-22) | — | ❌ paid plan | `/v3/snapshot` — the v2 snapshot carries no extended-hours fields, which is why the cache moved v2 → v3. |
| Index spot values (SPX/NDX/DJI/RUT/VIX) | **none — ETF proxies** | Polygon Indices add-on | ❌ | `/v2/aggs/I:SPX`, `I:VIX` → **403**. Contradicts the "Indices" row above: Polygon Starter does **not** serve index values. SPY/QQQ/DIA/IWM/VIXY are used as proxies and flagged `isProxy:true`. |
| Payments / subscription billing | **Stripe (PLANNED — not integrated)** | — | ✅ no monthly fee | See §1.1. No code exists; `payments`/`subscriptions` are empty. |

### 2.1 Polygon endpoint authorization — verified, not assumed

Plan: **Polygon Stocks Starter** (via Massive, `api.massive.com`). Every row was probed with the app's own key on 2026-07-21. `✅` = returned `200` with real data; `❌` = returned `403 NOT_AUTHORIZED` or `404`. Nothing here is quoted from vendor documentation — which matters, because the vendor-capability guesses in §1–§3 above were wrong in both directions.

**Measured limits:** delay is **exactly 900 s (15 min)**; daily history is **exactly 5 years rolling**; intraday depth ≥ 4 years; no rate limit reached.

| Endpoint | Status | Used by |
|---|---|---|
| `/v2/aggs/ticker/{sym}/range/1/day/…` | ✅ 200 | `stock-history.job.ts` → `ohlcv_bars` |
| `/v2/aggs/ticker/{sym}/range/{1,5,30}/minute/…` | ✅ 200 | `intraday-bars.job.ts` → `intraday_bars` |
| `/v2/aggs/grouped/locale/us/market/stocks/{date}` | ✅ 200 | movers, quotes, Fear & Greed |
| `/v2/snapshot/…/{tickers,gainers,losers}` | ✅ 200 | live quote, movers |
| `/v3/snapshot?ticker.any_of=` | ✅ 200 | `snapshot-cache.service.ts` — extended hours |
| `/v3/reference/tickers` · `/tickers/{sym}` | ✅ 200 | `ticker-universe`, `companies` |
| `/vX/reference/financials` | ✅ 200 | `financials.job.ts` — income + balance sheet + cash flow |
| `/v1/related-companies/{sym}` | ✅ 200 | `companies.job.ts` — peers |
| `/v3/reference/dividends` · `/splits` | ✅ 200 | `dividends.job.ts`, `corporate-actions.job.ts` |
| `/vX/reference/ipos` | ✅ 200 | `ipos.job.ts` |
| `/v2/reference/news` | ✅ 200 | `news.job.ts` |
| `/v1/indicators/{rsi,macd,sma,ema}/{sym}` | ✅ 200 | **authorized, unused** — computed in-house from bars instead |
| `/v1/marketstatus/{now,upcoming}` | ✅ 200 | `market-status.service.ts` → `GET /live/market-status` |
| `/v3/reference/options/contracts` | ✅ 200 | `options-chains.job.ts` — contract **reference only** |
| `/v2/aggs/ticker/O:{contract}/range/1/day/…` | ✅ 200 | `options-chains.job.ts` — per-contract OHLCV, VWAP, trade count |
| `/fed/v1/treasury-yields` | ✅ 200 | `market-indices.job.ts` — real US10Y |
| `/fed/v1/inflation` · `/inflation-expectations` | ✅ 200 | **authorized, unused** |
| `/v3/snapshot/options/{underlying}` | ❌ 403 | **no greeks, IV, open interest or bid/ask** |
| `/v3/snapshot/indices` · `/v2/aggs/ticker/I:SPX` · `I:VIX` | ❌ 403 | **no index spot values** — ETF proxies used instead |
| `/v2/last/trade/…` · `/v3/trades` · `/v3/quotes` | ❌ 403 | no tick data, no NBBO |
| `/benzinga/v1/{ratings,firms,earnings,guidance,news,analyst-insights}` | ❌ 403 | no per-firm analyst actions, no earnings session/guidance |
| `/v1/summaries` | ❌ 403 | — |
| `/stocks/vX/short-interest` · `/short-volume` | ❌ 404 | not served on this host at all — use FINRA files |
| `/futures/vX/products` | ❌ 404 | no WTI/GOLD futures — use commodity ETFs |

**WebSocket** (probed 2026-07-20): real-time cluster ❌ "no access"; `wss://delayed.polygon.io/stocks` channels `A` and `AM` ✅ authorized; `T` (trades) and `Q` (quotes) ❌ not authorized.

---

## 3. Recommended Vendor Stack (MVP)

| Slot | Vendor | Monthly Cost (est.) | What It Covers |
|---|---|---|---|
| Real-time quotes + OHLCV + block trades | Polygon.io Starter | ~$29 | WS quotes, REST OHLCV, block trades, indices |
| News + analyst actions + transcripts | Benzinga API | ~$149–299 (contact sales) | News feed WS, analyst ratings stream, earnings transcripts |
| Earnings calendar + sector + fundamentals | FMP Premium | ~$99 | Earnings calendar, actuals, transcripts (fallback), sector/group, PE/fundamentals |
| Macro/economic calendar | Finnhub | Free | Economic calendar, basic news, earnings surprises |
| Options chains (Options Chain screen `/menu/options`) | Tradier | Free (brokerage account) | Expiry dates + full call/put chain (strike, bid, ask, IV, volume, OI) |
| Options flow + unusual activity | Unusual Whales | ~$48 | Unusual options, dark pool, congressional trades |
| 13F filings | SEC EDGAR | Free | All 13F-HR filings, EDGAR full-text search |
| **Total MVP estimate** | | **~$325–475/mo** | |

> **Phase 2 additions**: Intrinio for deeper transcript/options coverage if Benzinga proves insufficient (~$250/mo add).  
> **Not recommended**: Motley Fool Transcripts API (too expensive), Refinitiv (enterprise only), Market Chameleon (no API).

> **⚠ Correction to the "Polygon.io Starter" row (2026-07-22).** The plan actually held does **not** deliver everything that row claims. Verified against the live key: **no real-time WebSocket quotes** (the real-time cluster refuses the key; only the *delayed* cluster's `A`/`AM` aggregate channels are authorized, and REST delay measures exactly 900 s), **no block trades** (the Trades API 403s, so the `block_trades` collection in §5.8 has no source), and **no index values** (SPX/NDX/DJI/RUT/VIX all 403 — the app uses ETF proxies and labels them). What it *does* deliver, beyond what the row credits it with, is 5 years of daily history, intraday aggregates, peers, dividends/splits history, full financial statements and the `/fed/v1/*` macro namespace. See §2.1.

> **Stripe (planned, ~$0/mo fixed + 2.9% + 30¢ per charge)** would slot in as a billing vendor alongside these data vendors. It is **not** included in the MVP total above because it is not integrated — see §1.1.

---

## 4. Data Flow: Scheduler → Firestore Architecture

```
[Vendor APIs]
      │
      ▼
[ECS Scheduler Workers]  (Python, one worker per data type)
      │  ── normalize to internal schema ──
      ▼
[Firestore Collections]  (domain data — all clients read from here)
      │
      ▼
[React SPA / Mobile]    (Firestore SDK real-time listeners OR REST)
```

**Important**: Real-time quotes are NOT written to Firestore (too expensive per read/write at tick frequency). Quote flow is:

```
Polygon.io WS → Redis quote cache (TTL 5s) → WebSocket Gateway → Client
                ClickHouse (OHLCV history)
```

Everything else (news, earnings, analyst actions, macro, options flow, 13F, movers snapshots) goes to Firestore.

---

## 5. Firestore Collection Schemas

> **Note on field naming:** All Firestore schemas use full, descriptive field names (e.g. `ticker`, `pctChange`, `priceTarget`). The current UI mock data in `app/iq/data.ts` uses abbreviated keys (e.g. `s`, `c`, `ptT`) for conciseness while the app runs on static data. When live API data replaces the static mock, the API responses will use the full field names defined in these schemas, and the UI interfaces will be updated to match.
>
> **UI interface → Firestore field quick reference:**
>
> | UI interface (`data.ts`) | Firestore collection | Key abbreviation pattern |
> |---|---|---|
> | `PulseItem { l, v, c, o, pc }` | `indexCards[]` in `recaps` | `l`=label, `v`=value, `c`=change, `o`=open, `pc`=prevClose |
> | `Earning { s, n, t, mc, sec, epsE, epsA, revE, revA, guide, react, tags, owned, implied }` | `earnings_events` | `s`=ticker, `n`=name, `t`=session(BMO/AMC), `mc`=marketCap, `epsE/A`=estimate/actual, `react`=priceReaction |
> | `Mover { s, n, p, c, rvol, rs, cat, ma, owned, sector, cap, wk, tech, news }` | `market_movers[].movers[]` | `p`=price, `c`=pctChange, `rs`=relativeStrength, `cat`=catalystLabel, `ma`=maPosture |
> | `AnalystAction { s, n, firm, dir, from, to, ptF, ptT, react, n30, owned }` | `analyst_actions` | `dir`=actionType(up/down/init/hold), `ptF/ptT`=prevPriceTarget/newPriceTarget, `n30`=actionsLast30Days |
> | `FolioItem { s, n, p, c, gl, size, conv, evt }` | `users/{uid}/portfolios/{id}/holdings/{ticker}` | `gl`=gainLossPct, `conv`=conviction, `evt`=eventNote |
> | `Fund { nm, av, mgr, aum, pos, top, newPos, exits, q }` | `fund_holdings` | `nm`=fundName, `av`=avatar/initials, `mgr`=managerName, `pos`=totalPositions, `q`=quarter |
> | `WatchItem { s, n, px, c, er, analyst, opt, headline }` | `users/{uid}/watchlists/{id}` (symbols[]) + live prices | `px`=price, `er`=nextEarningsDate, `opt`=hasOptions |
> | `StockInfo { name, px, c, mkt, pe, eps, wkh52, wkl52, div, beta, sec, ai_call, ai_thesis, ai_risk, ai_metrics, fin, news, ins }` | `companies` + `earnings_events` + `news` + Polygon OHLCV | `mkt`=marketCap, `wkh52/wkl52`=52weekHigh/Low, `ins`=insiderActivity |
> | `SectorRow { name, rank, trend, chg, items }` | `market_movers` (sector aggregates) | `chg`=pctChange, `items=[ticker, marketCap, pctChange][]` |
> | `ScreenerStock { s, n, sec, mc, pe, rs, salesG, epsG, mgn, rvol, rating }` | `companies` + live metrics | `mc`=marketCap(B), `rs`=relativeStrength0-100, `salesG/epsG`=growthPct, `mgn`=grossMarginPct |
> | `CommentaryItem { cat, accent, time, text, why }` | `news` | `cat`=category, `accent`=CSS color var (UI-only), `why`=whyItMatters |
> | `RecapData { date, subtitle, headline, indices, stories, tomorrow, movers, internals }` | `recaps` | See field mapping in §5.12 |
> | `OptionRow { k, atm, call:{last,bid,ask,iv,vol,oi,itm}, put:{...} }` | Not Firestore — Redis cache | `k`=strike; see §5.14 |

### 5.1 companies

Reference data for all tracked tickers. Updated daily.

```
Collection: companies
Document ID: {ticker}  (e.g., "AAPL")

{
  ticker:            string,          // "AAPL"
  name:              string,          // "Apple Inc."
  exchange:          string,          // "NASDAQ"
  sector:            string,          // "Technology"
  industry:          string,          // "Consumer Electronics"
  industryGroup:     string,          // MarketSurge-style group, e.g. "Software-Enterprise"
  marketCap:         number,          // in USD
  sharesOutstanding: number,
  float:             number,
  description:       string,
  cik:               string,          // SEC CIK for EDGAR lookups
  website:           string | null,
  ceo:               string | null,
  employees:         number | null,
  ipoDate:           string | null,   // "YYYY-MM-DD"
  source:            string,          // "fmp"
  updatedAt:         timestamp
}

Indexes needed:
  - sector ASC + marketCap DESC
  - industryGroup ASC + updatedAt DESC
```

---

### 5.2 earnings_events

Earnings calendar + actuals. Upserted every 15 min from FMP.

```
Collection: earnings_events
Document ID: {ticker}_{fiscalQuarterKey}  (e.g., "AAPL_2025Q2")

{
  ticker:              string,
  companyName:         string,
  reportDate:          timestamp,
  session:             "BMO" | "AMC" | "unknown",
  fiscalQuarter:       string,         // "Q2 2025"
  fiscalYear:          number,
  epsEstimate:         number | null,
  revenueEstimate:     number | null,  // in USD
  epsActual:           number | null,
  revenueActual:       number | null,
  epsSurprise:         number | null,  // % vs estimate
  revenueSurprise:     number | null,
  guidanceStatus:      "raised" | "lowered" | "maintained" | "none" | null,
  guidanceSummary:     string | null,
  resultPosted:        boolean,
  transcriptAvailable: boolean,
  transcriptUrl:       string | null,
  audioUrl:            string | null,  // Intrinio audio recording
  priceReaction:       number | null,  // % change post-earnings
  source:              string,         // "fmp"
  createdAt:           timestamp,
  updatedAt:           timestamp
}

Indexes needed:
  - reportDate ASC + session ASC
  - reportDate ASC + resultPosted ASC
  - ticker ASC + reportDate DESC
```

---

### 5.3 earnings_summaries

AI-generated summaries. Written once per earnings event by the earnings_summary BullMQ worker.

```
Collection: earnings_summaries
Document ID: {ticker}_{fiscalQuarterKey}  (matches earnings_events)

{
  ticker:          string,
  quarter:         string,               // "Q2 2025"
  beatMiss:        "beat" | "miss" | "in-line",
  tone:            "bullish" | "cautious" | "neutral" | "mixed",
  guidance:        string,               // 1-2 sentence summary
  keyRisks:        string[],             // array of risk bullets
  takeaway:        string,               // 1 sentence bottom line
  confidenceScore: number,               // 0.0–1.0
  model:           string,               // "claude-3-5-sonnet"
  promptVersion:   string,
  generatedAt:     timestamp,
  updatedAt:       timestamp
}
```

---

### 5.4 news

News articles. Written in real-time from Benzinga WS, supplemented by Finnhub.

```
Collection: news
Document ID: auto-generated

{
  id:             string,
  headline:       string,
  summary:        string,
  body:           string | null,        // full body (Benzinga paid)
  url:            string,
  source:         string,               // "benzinga" | "finnhub"
  author:         string | null,
  publishedAt:    timestamp,
  tickers:        string[],             // ["AAPL", "MSFT"] — array for compound queries
  categories:     string[],             // ["Earnings", "Analyst", "Macro", "Story", "Sector"]
  sentiment:      "positive" | "negative" | "neutral" | null,
  whyItMatters:   string | null,        // AI-generated 1 sentence
  importance:     "high" | "medium" | "low",
  createdAt:      timestamp
}

Indexes needed:
  - publishedAt DESC (default feed order)
  - tickers (array-contains) + publishedAt DESC
  - categories (array-contains) + publishedAt DESC
```

---

### 5.5 analyst_actions

Upgrades, downgrades, initiations, reiterations. Written every 5 min from Benzinga.

```
Collection: analyst_actions
Document ID: auto-generated

{
  id:                  string,
  ticker:              string,
  firm:                string,
  analystName:         string | null,
  actionType:          "upgrade" | "downgrade" | "initiation" | "reiteration" | "coverage_dropped",
  previousRating:      string | null,  // "Hold"
  newRating:           string,         // "Buy"
  previousPriceTarget: number | null,
  newPriceTarget:      number | null,
  currency:            string,         // "USD"
  publishedAt:         timestamp,
  priceAtAction:       number | null,
  priceChangeSince:    number | null,  // % change since action was published
  impliedUpside:       number | null,  // % from current price to price target
  impliedDownside:     number | null,
  aiNote:              string | null,  // AI-generated meaningfulness note
  source:              string,         // "benzinga"
  createdAt:           timestamp
}

Indexes needed:
  - publishedAt DESC
  - ticker ASC + publishedAt DESC
  - actionType ASC + publishedAt DESC
```

---

### 5.6 macro_events

Economic calendar events. Synced daily at 6am ET from Finnhub.

```
Collection: macro_events
Document ID: auto-generated  (or {date}_{event_slug} for deduplication)

{
  id:          string,
  name:        string,         // "US CPI MoM"
  country:     string,         // "US"
  currency:    string,         // "USD"
  eventDate:   timestamp,
  actual:      number | null,
  estimate:    number | null,
  previous:    number | null,
  unit:        string | null,  // "%", "K", "B"
  importance:  "high" | "medium" | "low",
  description: string | null,
  source:      string,         // "finnhub"
  createdAt:   timestamp,
  updatedAt:   timestamp
}

Indexes needed:
  - eventDate ASC + importance ASC
  - country ASC + eventDate ASC
```

---

### 5.7 options_flow

Unusual options activity. Written in real-time from Unusual Whales WS.

```
Collection: options_flow
Document ID: auto-generated

{
  id:                string,
  ticker:            string,
  strikePrice:       number,
  expirationDate:    timestamp,
  daysToExpiry:      number,
  optionType:        "call" | "put",
  contractSize:      number,          // number of contracts
  premium:           number,          // per-contract premium
  totalValue:        number,          // total notional value in USD
  impliedVolatility: number,          // as decimal e.g. 0.45
  volOiRatio:        number,          // volume / open interest
  side:              "bid" | "ask" | "mid",
  directionFlag:     "bullish" | "bearish" | "neutral",
  isSweep:           boolean,
  isUnusual:         boolean,
  isBlock:           boolean,
  tradeTime:         timestamp,
  source:            string,          // "unusual_whales"
  createdAt:         timestamp
}

Indexes needed:
  - tradeTime DESC
  - ticker ASC + tradeTime DESC
  - isUnusual ASC + tradeTime DESC
  - directionFlag ASC + tradeTime DESC
```

---

### 5.8 block_trades

Large single trades. Written in real-time from Polygon.io Trades API.

```
Collection: block_trades
Document ID: auto-generated

{
  id:              string,
  ticker:          string,
  tradeValue:      number,       // total USD value (price × shares)
  shares:          number,
  price:           number,
  vwap:            number | null,
  vwapDiffPct:     number | null, // % above/below VWAP
  exchange:        string,
  conditions:      string[],     // trade condition codes
  directionContext: "above_ask" | "below_bid" | "at_mid" | null,
  tradeTime:       timestamp,
  source:          string,       // "polygon"
  createdAt:       timestamp
}

Indexes needed:
  - tradeTime DESC
  - ticker ASC + tradeTime DESC
  - tradeValue DESC + tradeTime DESC
```

---

### 5.9 fund_holdings

13F institutional holdings. Written nightly from SEC EDGAR parser.

```
Collection: fund_holdings
Document ID: {cik}

{
  cik:             string,
  fundName:        string,
  managerName:     string | null,
  latestFilingDate: timestamp,
  latestReportDate: timestamp,   // end of quarter
  totalValue:      number,       // in thousands (as reported)
  totalPositions:  number,
  aiSummary:       string | null,
  updatedAt:       timestamp
}

Sub-collection: fund_holdings/{cik}/filings/{filing_id}
{
  filingDate:      timestamp,
  reportDate:      timestamp,
  totalValue:      number,
  totalPositions:  number,
  source:          string,       // "edgar"
  createdAt:       timestamp
}

Sub-collection: fund_holdings/{cik}/filings/{filing_id}/positions/{ticker}
{
  ticker:          string,
  cusip:           string,
  companyName:     string,
  shares:          number,
  value:           number,       // in thousands
  putCall:         "put" | "call" | null,
  changeType:      "new" | "added" | "trimmed" | "exited" | "unchanged",
  shareChange:     number,       // delta vs prior quarter (0 if new/unchanged)
  pctPortfolio:    number        // % of fund's total reported value
}

Indexes needed:
  - fund_holdings: latestFilingDate DESC
  - positions: pctPortfolio DESC
  - positions: changeType ASC + value DESC
```

---

### 5.10 market_movers

Pre-calculated movers snapshots. Written every minute during market hours by movers worker (sourced from ClickHouse + Redis).

```
Collection: market_movers
Document ID: {date}_{session}_{type}  (e.g., "2025-06-10_regular_gainers")

{
  date:          string,         // "YYYY-MM-DD"
  session:       "premarket" | "regular" | "afterhours",
  type:          "gainers" | "losers" | "volume" | "gap_up" | "gap_down" | "high_rvol" | "weekly",
  movers: [
    {
      ticker:        string,
      pctChange:     number,
      priceChange:   number,
      price:         number,
      volume:        number,
      rvolRatio:     number,       // vs 30-day avg volume
      catalystLabel: string | null,
      maPosture:     string | null, // "Above 21/50/200" etc.
      sector:        string | null,
      float:         number | null
    }
  ],
  generatedAt:   timestamp
}

Indexes needed:
  - date DESC + session ASC + type ASC
```

---

### 5.11 story_stocks

AI-tagged story cards. Written by story_stocks BullMQ worker; auto-published.

```
Collection: story_stocks
Document ID: auto-generated

{
  id:               string,
  ticker:           string,
  headline:         string,
  what:             string,        // what is happening
  why:              string,        // why it matters
  whatChangedToday: string,        // today's trigger/update
  nextCatalystDate: timestamp | null,
  nextCatalyst:     string | null, // "FDA decision", "Earnings Q2"
  peerImpact:       string,        // impact on sector/peers
  tags:             string[],      // ["activist", "fda", "earnings_catalyst", "technical_breakout"]
  triggerType:      "news_cluster" | "price_volume_anomaly" | "activist_filing" | "regulatory_event",
  sourceNewsIds:    string[],      // references to news collection
  isActive:         boolean,
  publishedAt:      timestamp,
  updatedAt:        timestamp
}

Indexes needed:
  - publishedAt DESC + isActive ASC
  - ticker ASC + publishedAt DESC
  - tags (array-contains) + publishedAt DESC
```

---

### 5.12 recaps

EOD and weekly recaps. Written by recap BullMQ workers. Schema matches the `RecapData` interface in `app/iq/data.ts`.

```
Collection: recaps
Document ID: "daily_{YYYY-MM-DD}" | "weekly_{YYYY}-W{ww}"

{
  type:         "daily" | "weekly",
  date:         string,           // "2025-06-10" or "2025-W23"

  // ── Recap hero (top section) ──
  title:        string,           // headline e.g. "Markets closed broadly higher..."
  subtitle:     string,           // "auto-generated 4:31 ET"
  indices: [
    { label: string; value: number }  // e.g. { label: "S&P 500", value: 0.73 }
  ],

  // ── Index pulse cards (RcpIndexCards component) ──
  // Same shape as PulseItem in data.ts; 9 market indices
  indexCards: [
    { label: string; value: number; change: number; open: number; prevClose: number }
  ],

  // ── News briefing (NewsBriefing newspaper spread) ──
  newsLead:   string,             // lead paragraph shown on Page 1 of spread
  newsItems: [
    { headline: string; body: string; sym?: string }
    // up to 7 items (daily) / 6 items (weekly); sym used for inline $TICKER parsing
  ],

  // ── 2-column key stories + tomorrow's events ──
  stories:    string[],           // bullet story lines
  tomorrow: [
    { time: string; event: string }
    // e.g. { time: "8:30a", event: "Initial jobless claims" }
  ],

  // ── Bottom grid ──
  movers: [
    { ticker: string; reason: string; pctChange: number }
  ],
  internals: [
    { label: string; value: string; direction: 1 | -1 | 0 }
    // direction: 1 = positive, -1 = negative, 0 = neutral
  ],
  sectorPerformance: [
    { name: string; change: number }
  ],

  // ── Audio (Phase 2) ──
  audioUrl:     string | null,    // S3 presigned URL for mp3
  audioDuration: number | null,   // seconds
  audioScript:  string | null,    // 60-sec TTS script

  emailSentAt:  timestamp | null,
  generatedAt:  timestamp
}

Indexes needed:
  - type ASC + date DESC
```

**UI → Firestore field mapping (data.ts `RecapData` uses short keys in mock data):**

| UI mock field | Firestore field | Notes |
|---|---|---|
| `date` | `date` | Same |
| `subtitle` | `subtitle` | Same |
| `headline` | `title` | Renamed for clarity |
| `indices[].l` / `.v` | `indices[].label` / `.value` | Expanded |
| `stories[]` | `stories[]` | Same |
| `tomorrow[].time` / `.ev` | `tomorrow[].time` / `.event` | `.ev` → `.event` |
| `movers[].s` / `.reason` / `.c` | `movers[].ticker` / `.reason` / `.pctChange` | `.s` → `.ticker`, `.c` → `.pctChange` |
| `internals[].l` / `.v` / `.c` | `internals[].label` / `.value` / `.direction` | `.c` → `.direction` |
| `NEWS_DAILY` / `NEWS_WEEKLY` (local arrays in recap.tsx) | `newsItems[]` | Moved to Firestore for live data |
| `DAILY_LEAD` / `WEEKLY_LEAD` (local constants in recap.tsx) | `newsLead` | Moved to Firestore |
| `pulse[]` (global from data.ts) | `indexCards[]` | Recap-specific snapshot |

---

### 5.13 stock_comments

User-generated chart notes. Written and read directly from the React client using the Firebase client SDK. No server worker — this is the first collection written directly by authenticated users (not via Admin SDK).

```
Collection: stock_comments
Document ID: auto-generated

{
  uid:       string,     // Firebase Auth user ID — used to scope reads
  sym:       string,     // stock ticker e.g. "NVDA"
  name:      string,     // company name e.g. "NVIDIA Corp."
  comment:   string,     // note text (max 2000 chars)
  createdAt: Timestamp   // Firestore server timestamp
}

Indexes needed:
  - uid ASC + sym ASC + createdAt ASC (composite — required for the query filter)
```

Client code (screens/stock.tsx):
- `loadNotes(sym)`: query where uid + sym, orderBy createdAt desc
- `saveNote(sym, name, comment)`: addDoc with Timestamp.now()
- `deleteNote(id)`: deleteDoc by document ID

Security rules: owner read/write/delete only; no update (immutable); create validates uid matches auth.uid.

---

### 5.14 Options Chain (not Firestore — on-demand API call)

Options chain data is **not written to Firestore** — it's fetched on-demand from Tradier and cached in Redis. Chains change tick-by-tick so storing them in Firestore would be prohibitively expensive.

**Tradier API endpoints:**
```
GET /v1/markets/options/expirations?symbol={SYM}&includeAllRoots=true
→ Returns: { expirations: { date: string[] } }
   Used for the expiry tab row in OptionsScreen.

GET /v1/markets/options/chains?symbol={SYM}&expiration={YYYY-MM-DD}&greeks=false
→ Returns: { options: { option: OptionContract[] } }
```

**Normalized OptionRow schema** (matches `OptionRow` interface in `screens/options.tsx`):
```
{
  strike:     number,
  atm:        boolean,          // true if strike == ATM strike
  call: {
    last:     number,
    bid:      number,
    ask:      number,
    iv:       number,           // implied volatility as decimal e.g. 0.45
    volume:   number,
    oi:       number,           // open interest
    itm:      boolean           // in-the-money: strike < currentPrice
  },
  put: {
    last:     number,
    bid:      number,
    ask:      number,
    iv:       number,
    volume:   number,
    oi:       number,
    itm:      boolean           // in-the-money: strike > currentPrice
  }
}
```

**API endpoint (backend):**
```
GET /api/v1/options/expirations?sym={SYM}
  → proxies Tradier; returns string[] of expiry dates

GET /api/v1/options/chain?sym={SYM}&expiry={YYYY-MM-DD}
  → proxies Tradier; normalizes to OptionRow[]; cached Redis `options:{sym}:{expiry}` TTL 60s
  → 401 if unauthenticated, 403 if Free tier (options require Pro+)
```

**Redis cache key:** `options:{sym}:{expiry}` — TTL 60 seconds during market hours, 10 minutes after close.

**Current UI state:** `buildChain()` in `screens/options.tsx` generates fully deterministic seeded data using `optRand()`. The seeded chain mirrors the Tradier contract structure exactly, so replacing it with live data is a drop-in swap.

---

### 5.16 User Collections

```
Collection: users
Document ID: {firebase_uid}

{
  uid:             string,
  email:           string,
  displayName:     string | null,
  photoUrl:        string | null,
  tier:            "free" | "pro" | "premium",
  stripeCustomerId: string | null,   // ⚠ always null — Stripe is not integrated (§1.1)
  stripeSubId:     string | null,    // ⚠ always null — Stripe is not integrated (§1.1)
  onboardedAt:     timestamp | null,
  createdAt:       timestamp,
  updatedAt:       timestamp
}

---

Sub-collection: users/{uid}/portfolios/{portfolioId}
{
  name:      string,
  isDefault: boolean,
  createdAt: timestamp
}

---

Sub-collection: users/{uid}/portfolios/{portfolioId}/holdings/{ticker}
Document ID: {ticker}
{
  ticker:         string,
  shares:         number,
  avgCostBasis:   number | null,
  conviction:     "high" | "medium" | "low" | null,
  notes:          string | null,
  addedAt:        timestamp,
  updatedAt:      timestamp
}

---

Sub-collection: users/{uid}/watchlists/{watchlistId}
{
  name:      string,
  tickers:   string[],   // ordered list, max 5 for Free
  createdAt: timestamp,
  updatedAt: timestamp
}

---

Sub-collection: users/{uid}/alerts/{alertId}
{
  type:             "earnings" | "analyst" | "volume" | "price" | "52wk_breakout" |
                    "peer_move" | "macro_event" | "block_trade" | "13f_filing" |
                    "group_rs_rank" | "options_unusual" | "price_target_hit",
  ticker:           string | null,   // null for macro/market-wide alerts
  threshold:        number | null,
  deliveryChannels: string[],        // ["email", "in_app", "sms", "push"]
  enabled:          boolean,
  createdAt:        timestamp
}

---

Sub-collection: users/{uid}/notifications/{notificationId}
{
  alertId:   string | null,
  type:      string,
  title:     string,
  body:      string,
  link:      string | null,    // deep link in app
  read:      boolean,
  createdAt: timestamp
}
```

---

## 6. Scheduler Summary

| Worker | Source | Frequency | Writes To | Notes |
|---|---|---|---|---|
| Quote Ingestion | Polygon.io WS | Real-time | Redis quote cache (TTL 5s) | NOT Firestore — too expensive |
| OHLCV Ingestion | Polygon.io REST | On-demand + backfill | ClickHouse | Historical tick + candle data |
| News Ingestion | **Polygon + FMP REST (merged)** *(FMP wired 2026-08-16)* | Premarket + on-demand | Firestore `news` | `news.job.ts` merges Polygon `/v2/reference/news` + FMP `/stable/news/stock`, deduped by URL (Polygon wins); each doc carries `vendor`. (Benzinga WS never wired.) |
| Earnings Calendar Sync | FMP REST | Premarket (MARKET_WIDE phase) | Firestore `earnings_events` | Upsert by ticker+quarter key. **Full-US** since 2026-08-16 (forward calendar filtered via Polygon `tickers` ref). |
| Analyst Actions Ingest | Benzinga REST | Every 5 min | Firestore `analyst_actions` | Real-time feed |
| Macro Calendar Sync | Finnhub REST | Daily 6am ET | Firestore `macro_events` | Upsert by date+event slug |
| Options Chain (on-demand) | Tradier REST | On-demand + 60s cache | Redis `options:{sym}:{expiry}` (NOT Firestore) | Powers `/menu/options` screen; never written to Firestore |
| Options Flow Ingest | Unusual Whales WS | Real-time | Firestore `options_flow` | Filter for isUnusual=true |
| EDGAR 13F Parser | SEC EDGAR | Nightly + on filing | Firestore `fund_holdings` | Phase 2 |
| Block Trade Ingest | Polygon.io Trades | Real-time | Firestore `block_trades` | Filter: value > $500k or shares > 10k |
| Company Reference Sync | FMP REST | Daily | Firestore `companies` | Full upsert |
| Movers Calculation | ClickHouse + Redis | Every 1 min (market hours) | Firestore `market_movers` | Calculated server-side, snapshot written |
| Story Stocks Worker | BullMQ (triggered) | Event-driven | Firestore `story_stocks` | AI tagging via Claude API |
| EOD Recap Worker | BullMQ cron | 4:30pm ET | Firestore `recaps` | Claude summarizes from structured data |
| Weekly Recap Worker | BullMQ cron | Friday 6pm ET | Firestore `recaps` | Separate Claude call for portfolio tab |
| **Intraday Bars** *(new 2026-07-22)* | Polygon REST | `25 16 * * 1-5` ET | Firestore `intraday_bars` | One doc per `{ticker}_{5min\|30min}` holding an **array** of bars, not a doc per bar |
| **Corporate Actions** *(new 2026-07-22)* | Polygon REST | `40 6 * * *` ET | Firestore `dividend_history`, `splits` | Full payment history, annual totals, TTM, derived yield, 5y CAGR, increase streak |

> **⚠ None of this schedule is running.** As of 2026-07-22 there are **no Cloud Scheduler jobs in any region** and no `scheduler-invoker` service account — `create-scheduler-jobs.sh` was never run. Cloud Run is deployed with `min-instances=0`, so the in-process `@Cron` decorators never fire. **No sync job has ever executed automatically in production**; all current data was produced by manual `POST /sync/{job}/run` invocations. Every frequency in the table above is therefore aspirational, not observed.

---

## 7. Architecture Notes & Recommendations

### ✅ No Architecture Changes Required

The existing architecture (ECS workers → Firestore + Redis + ClickHouse) is correct as designed. Firebase Auth replaces Auth0 for user identity, Firestore replaces PostgreSQL for all domain data, and Redis + ClickHouse remain for their specific workloads.

### ⚠️ Important: Do NOT write real-time quotes to Firestore

Writing per-tick quote data to Firestore would be prohibitively expensive (Firestore bills per document write). The quote flow must stay:
`Polygon WS → Redis (TTL 5s) → WebSocket Gateway → Client`

### 💡 Consider: Replace WebSocket feed with Firestore real-time listeners

For the news/analyst actions live feed (not quotes), you could use **Firestore real-time listeners** on the client instead of the WebSocket + Redis pub/sub fan-out. Benefits:
- Removes the WebSocket gateway ECS service
- Built-in offline support and reconnect
- Simpler client code

Downside: Firestore charges per read per listener update at scale. For 1,000+ concurrent users on a busy day, Redis pub/sub + WebSocket remains cheaper. Recommend keeping WebSocket for now; revisit at 500+ paid subscribers.

### ⚠️ Transcript Vendor

The image lists Motley Fool Transcripts API and Refinitiv — both are enterprise-priced and not practical for MVP.

**Recommendation**: Use **FMP earnings transcripts** (included in paid FMP plan) as primary. Benzinga also offers Conference Call Transcripts as an add-on. Only add Intrinio if transcript coverage proves insufficient.

### 💡 Firestore Indexes

Define these in `firestore.indexes.json` before go-live (Firestore requires composite indexes for multi-field queries):
- `news`: `(tickers array-contains, publishedAt DESC)`
- `news`: `(categories array-contains, publishedAt DESC)`
- `analyst_actions`: `(ticker ASC, publishedAt DESC)`
- `earnings_events`: `(reportDate ASC, session ASC)`
- `options_flow`: `(ticker ASC, tradeTime DESC)`
- `market_movers`: `(date DESC, session ASC, type ASC)`

### 📋 New File Needed

Add a `06_Firestore_Security_Rules.md` or `firestore.rules` file defining read/write access per collection. Suggested rule: all market data collections (news, earnings, analyst_actions, etc.) are readable by any authenticated user; writes are server-side only (Firebase Admin SDK from ECS workers, blocked on client).
