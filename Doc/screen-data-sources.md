# MarketCatalyst Screen Data Sources

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
> **This doc, specifically:** For screen sources: the earnings Income-statement + EPS/Sales tabs, heatmap modals, and dashboard Market Pulse are all real now.
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


_Last verified: 2026-07-09, against the actual code in `app/iq/screens/*.tsx` and `backend/src/sync/*.job.ts`. See `Doc/openapi.yaml` for the full data contract and `Doc/schema.sql` if this ever migrates off Firestore. (2026-07-09 also added backend ops tooling — sync_meta collections/cron/next-run tracking, `POST /sync/run-all`, `backendUI/index.html` dashboard polish — none of which touches a MarketCatalyst screen, so nothing below changed from this pass.)_

> **Update 2026-07-12 — backend vendor migration to Polygon.** Several jobs were re-pointed to Polygon as primary (FMP/Finnhub kept as fallback), so the *source* of already-live data changed even though **what's live did not** (live/dynamic stayed ~44%, static ~56% — subsequently raised to **~48% live / ~52% static** by the computed indicator/score jobs; see the 2026-07-12 part 2 note below). Now Polygon-primary: **dividends** (`/v3/reference/dividends`), **IPOs** (`/vX/reference/ipos`), **sector performance** (SPDR sector-ETF proxies), **index quotes** (ETF-proxy daily aggs), and **company profile** — including **P/E now computed from Polygon `/vX/reference/financials` TTM EPS**. Stays non-Polygon (no product exists): **earnings calendar** + **analyst consensus** (FMP; Polygon 404s), **peers** + **dividend yield** (null on Polygon), **macro** (FRED), **SEC filings** (EDGAR). Also this session: Stock Detail candles fixed (Firestore index/query-direction bug), a live market-open/closed indicator added to the shell header, and the stale FMP pill labels corrected (Stock Detail "live quote · Polygon", Macro "Live Dividend Calendar · Polygon"; Earnings/Analyst stay FMP — those data weren't migrated)._
>
> **Update 2026-07-12 (part 2) — computed indicators/scores now backed by real jobs.** New no-vendor compute jobs turn several previously-🔴 "proprietary/no source" data points 🟡 (code-complete, live once the jobs run): **RSI/MACD** (Stock Detail — from real `ohlcv_bars`, replacing the seeded values; the scalar values are real, the plotted RSI-pane curve stays seeded pending a stored series), **RVOL** (Screener + Movers), **Tech Rating** + **rank within sector** (Screener + Stock Detail), **sales/EPS growth** + **gross margin** (Screener — from Polygon financials), and **Fear & Greed** (Dashboard gauge — from `market_sentiment/fear_greed`). All bounded-storage (upsert onto `companies`), no key/quota. Also: news is now multi-source **aggregated** (Polygon + Finnhub merged, not fallback), and ticker search matches **company name** (nameLower/searchTokens on `tickers`)._

> **Update 2026-07-21/22 — Polygon data wiring + subscriptions/entitlements/admin analytics.** Two bodies of work landed. **(A)** Eighteen previously-generated surfaces became live, all served by the *existing* Polygon Stocks Starter plan — nothing was purchased. Five new Firestore collections are now read by screens: **`intraday_bars`** (one doc per `{ticker}_{5min|30min}` holding an array of bars — powers 1D/1W/1M charts), **`dividend_history`** (full payment history + annual totals + TTM + derived yield + 5y CAGR + increase streak), **`splits`**, **`plans`**, and **`feature_adoption`**. `ohlcv_bars` backfilled 300 days → **5 years** (299,552 docs), so the 5Y chart is real too. `technical-indicators.job.ts` now stores an RSI series, MA/EMA ladders, VWAP, 52-week high/low and average volumes. The **US10Y tile is now the real Treasury yield** (`/fed/v1/treasury-yields`, `isProxy:false`) — it was previously the **TLT ETF, which moves inversely to the yield it was labelled as**. See [POLYGON-FEATURE-CROSSCHECK.md](./POLYGON-FEATURE-CROSSCHECK.md) for the per-endpoint entitlement probes; that file is authoritative on what the plan does and does not serve.
> **(B)** A `plans`/entitlements layer (3 plans, 30 entitlement keys) now gates nav items and screens, client feature usage is recorded to `feature_adoption`, and the **admin console renders real Firestore data** — see the new Admin Console section below.
>
> Two caveats that apply throughout: **the browser cannot reach the backend in production** (`NEXT_PUBLIC_BACKEND_URL` is unset, so `http://localhost:4100` is baked into the static bundle and blocked as mixed content), which disables the market-status pill, extended-hours moves and the Monitor tab in production only. And **no Cloud Scheduler jobs exist**, so with `min-instances=0` the in-process `@Cron` decorators never fire — every row marked ✅ below was populated by a manual job run, and stays fresh only if jobs are run manually.

> **Legend**
> - ✅ **Live** — data comes from a real Firestore collection written by a backend sync job (or Firebase Auth/user-owned Firestore data)
> - 🟡 **Hybrid** — live data is merged additively on top of the original mock content (matching tickers get real values; the rest of the mock stays, so nothing was deleted to make room for live data)
> - 🔴 **Static** — all data is hardcoded mock data in `app/iq/data.ts` or inline in the screen file; either no backend job exists yet, or the field genuinely has no live source

**The merge-not-replace rule:** every "Hybrid" row below was deliberately built to overlay live data onto the *existing* mock UI, never to delete a feature, tab, or mock dataset to make room for it. Where a live collection can't cover every field a mock object has (e.g. RVOL, a "why it's moving" narrative), the mock value is kept for that specific field. See individual screen sections for exactly which fields are real vs. still illustrative.

---

## Full-market ticker data (`tickers/{ticker}`)

Real, complete data for essentially the **entire US market** (~10,000+ tickers), not just the curated 241-ticker `TICKER_UNIVERSE` `companies` covers. Two independently-synced parts:
- **Reference metadata** (name, exchange, type, active, cik) — weekly, `ticker-universe.job.ts`
- **Price/%change/volume** — daily, `market-quotes.job.ts`. Essentially free: reuses the same 2-call Polygon grouped-daily diff `market-movers.job.ts` already computes for the whole market and then discards outside its top/bottom 20 — see `backend/src/vendors/polygon/polygon-diff.util.ts`.

Still missing at this full-market scale: fundamentals (P/E, sector, dividend yield, peers, beta) — that needs one FMP call per ticker, which doesn't scale here without a verified quota increase, so it stays limited to the curated 241.

**Now wired to one consumer**: the shell's Cmd+K/top search bar (`app/iq/hooks/useTickerSearch.ts`) searches this full collection by ticker prefix — see the Shell/Layout section below. Screener's own ticker picker/filters still only cover the curated 241 — expanding Screener itself to the full universe is a separate, not-yet-done step.

---

## Shell / Layout (all screens)

| Element | Source | Status |
|---|---|---|
| User display name | Firestore profile → Redux `state.profile.data.name` | ✅ Live |
| User profile image | Firestore `profile_image` or Firebase Auth `photoURL` → Redux | ✅ Live |
| Auth session / redirect | Firebase Auth `onAuthStateChanged` → Redux | ✅ Live |
| Theme preference | `IQShell` useState + Firestore `settings/{uid}` (font/alert) + localStorage cache | ✅ Live |
| **Ticker strip prices** (top of every screen) | `app/iq/shell.tsx` now uses the same `mergePulse()` helper (extracted to `app/iq/live-market-indices.ts`) as Dashboard's own Market Pulse widget — both read `market_indices` and stay in sync; the index drawer it opens now receives the same merged array as a prop instead of re-reading the stale static one | 🟡 Hybrid |
| **Cmd+K / top search bar** (new) | Real ticker-prefix search over the full `tickers` collection (~10,000+ tickers, real price/%change), via `app/iq/hooks/useTickerSearch.ts` — a scoped on-demand Firestore query, not a full-collection subscription (see that file's docblock for why). The original curated 15-name `SEARCHABLE_STOCKS` list stays as the "quick access" suggestions shown before typing anything, and fills in any gaps if a typed prefix matches a curated name not yet returned by the live query | 🟡 Hybrid |
| Cmd+K starred stocks | `IQShell` useState `starred: Set<string>` — in-memory per session | 🔴 Static (session-only) |
| **US10Y tile** in the ticker strip | `market_indices/US10Y` — now the **real Treasury 10-year yield** from Polygon `/fed/v1/treasury-yields` (`isProxy:false`, `unit:"percent"`). Previously this tile carried **TLT**, a bond ETF that moves *inversely* to the yield it was labelled as, so the sign was wrong as well as the magnitude. SPX/NDX/DJI/RUT/VIX/WTI/GOLD/DXY remain ETF proxies (`isProxy:true`) — index and futures values are 403/404 on this plan | ✅ Live |
| **Market open/closed pill** | `GET /live/market-status` (backend `market-status.service.ts` → Polygon `/v1/marketstatus/{now,upcoming}`), replacing a local clock plus a hand-maintained holiday list | ⚠️ Live locally, **falls back to the local-clock computation in production** — the browser can't reach the backend (see the note at the top) |
| **Nav item visibility** | `plans/{id}.featureFlags` → `useSlugEntitled()` / `SLUG_ENTITLEMENT` in `app/iq/entitlement-gate.tsx`. A screen the user's tier doesn't include is hidden from nav and shows a `PlanGate` upgrade panel if reached directly | ✅ Live |
| **Feature usage tracking** | `app/iq/track-feature.tsx` writes `feature_adoption/{uid}_{feature}` (48 tracked features — every screen in `menuItems` plus in-app actions: the 8 stock drawers, chart timeframe/indicator/expand, watchlist add/remove, search, screener, news). 30-second dedupe; `openCount` may only increase; failures are swallowed so analytics can never break a screen. **The only client-writable analytics collection** — the browser has no backend route to write through | ✅ Live |

**Two independent gates, deliberately not merged.** `FF_*` release flags (`feature-flags.registry.ts`) answer *"is it built and shipped?"*; plan entitlements (`plans.registry.ts`) answer *"may this tier use it?"*. A feature is usable only when both are true, and they render differently — "coming soon" vs "upgrade to unlock". `backtesting` and `paperTrading` are granted on Pro but **not built**, so they correctly show "coming soon" rather than a paywall.

---

## Dashboard (`/dashboard`) — `screens/dashboard.tsx`

All 14 original widgets are intact; live data is merged in via `useCollection()` calls at the top of `DashboardScreen()`.

| Widget | Data | Status |
|---|---|---|
| Market Pulse strip (6 of 9 indices shown) | `market_indices` merged onto `data.pulse` by label→symbol map (SPX/NDX/DJI/RUT/VIX/US10Y/WTI/GOLD/DXY — see `x-primary-source` on `/market-indices` in the OpenAPI spec). **US10Y is no longer a proxy**: it is the real Treasury yield from `/fed/v1/treasury-yields` (`isProxy:false`); the other eight stay ETF-proxied because index spot (`I:SPX`, `I:VIX`) is 403 and futures 404 on this plan | 🟡 Hybrid |
| VIX card | Same `market_indices` merge (VIX proxy = VIXY) | 🟡 Hybrid |
| Market Movers widget (Gainers/Losers/Most Active tabs) | `market_movers` merged onto `data.movers` (price/%/name/sector/cap real; RVOL/catalyst/weekly-% still mock) | 🟡 Hybrid |
| Market Heatmap mini | `sectors` + `companies` merged onto `data.sectorList` (sector %, per-stock market cap/%change real) | 🟡 Hybrid |
| Earnings Today widget | `earnings_events` merged onto `data.earnings` by ticker (EPS estimate/actual real; session/guidance/reaction still mock) | 🟡 Hybrid |
| Insider & Institutional mini | `insider_transactions` (latest 5 real Form 4 filings) prepended to the mock insider mini-list | 🟡 Hybrid |
| Live Market Feed | Real `news` docs shown when any exist for the tracked universe; falls back to the original mock feed items when none have synced yet. Polygon-primary as of 2026-07-08 — docs now carry `sentiment`/`sentimentReasoning`/`keywords` when served from Polygon (null/empty on Finnhub fallback) | 🟡 Hybrid |
| What Matters Now (AI card) | `data.wmn` — hardcoded (needs Claude; see Recaps note below) | 🔴 Static |
| Fear & Greed gauge | `market_sentiment/fear_greed`, computed in-house from Polygon `/v2/aggs/grouped/…`. The job had been writing this all along — the collection had **no Firestore rule at all**, so default-deny silently blocked every client read and the gauge fell back to its hardcoded `62`/"Greed" with no visible error. Rule added 2026-07-22 | ✅ Live |
| Analyst Actions mini-list | `analyst_actions` consensus pill shown next to matching tickers; per-firm action rows stay `data.analyst` (no live per-firm event feed exists) | 🟡 Hybrid |
| Screener Leaders & Laggards mini | `data.screenerStocks` — hardcoded | 🔴 Static |
| Portfolio Pulse mini | Signed-in user's real `users/{uid}/portfolios/default/holdings` merged with `companies` for live price/%; falls back to `data.folio` if the user has no saved holdings | 🟡 Hybrid |
| Watchlist mini | Signed-in user's real `users/{uid}/watchlists/default` merged with `companies` for live price/%; falls back to `data.watch` if the user has no saved watchlist | 🟡 Hybrid |
| Recaps card (download buttons) | Client-side `Blob` generation, no real report content | 🔴 Static |

---

## Earnings Hub (`/menu/earnings`) — `screens/earnings.tsx`

| Element | Data | Status |
|---|---|---|
| EPS estimate / actual | `earnings_events` overlaid onto the matching `EARN_CAL` row by ticker, tagged with a "live EPS · FMP" pill when live | 🟡 Hybrid |
| Calendar structure (Today/Week/Month tabs, session BMO/AMC, date grid) | `EARN_CAL` — hardcoded; the calendar is built around a fixed illustrative "today", not a live date range | 🔴 Static |
| Guidance status, price reaction, implied move | Hardcoded — no live source has these fields (FMP's calendar has no guidance/reaction; needs Benzinga) | 🔴 Static |
| Earnings call summaries / transcripts | `CALLS_DATA` — hardcoded AI-style summaries | 🔴 Static |

---

## Market Movers (`/menu/movers`) — `screens/movers.tsx`

| Element | Data | Status |
|---|---|---|
| Mover rows (price, %change, name, sector, cap) | `market_movers` merged onto `data.movers`; live-only tickers not in the mock set are appended with neutral placeholders | 🟡 Hybrid |
| RVOL, catalyst label, weekly-% column, "Trending across reports" widget | `data.movers`/`data.analyst`/`data.earnings`/`data.watch`/`data.folio` — hardcoded (no vendor field for RVOL or a "why it moved" narrative) | 🔴 Static |
| Sliding drawer (embedded Stock Detail) | Same sources as Stock Detail below | 🟡 Hybrid |

---

## Market Heatmap (`/menu/heatmap`) — `screens/heatmap.tsx`

| Element | Data | Status |
|---|---|---|
| Sector cells (% change) | `sectors` merged onto `data.sectorList` by sector name | 🟡 Hybrid |
| Stock cells (market cap, % change) | `companies` merged onto each sector's `items[]` by ticker (marketCap converted from raw USD to $B) | 🟡 Hybrid |
| Hover tooltip (RVOL, RS, MA posture) | Still sourced from mock `movers`/`screenerStocks` — no live technical-analysis source exists | 🔴 Static |

---

## Analyst Actions (`/menu/analyst`) — `screens/analyst.tsx`

| Element | Data | Status |
|---|---|---|
| "Live analyst consensus" card (new) | `analyst_actions` — real FMP Buy/Hold/Sell vote-count snapshot, shown as its own card since it can't populate the event table below | ✅ Live |
| Per-firm action table (firm, rating change, PT, cluster alerts) | `data.analyst` — hardcoded. FMP's consensus snapshot has no firm name/action type/date, so this table can't be live yet without Benzinga (blocked, no key) or FMP `grades-historical` (unwired interim option) | 🔴 Static |
| Live-consensus badge on matching table rows | Cross-references `analyst_actions` by ticker | ✅ Live (badge only) |

---

## Screener (`/menu/screener`) — `screens/screener.tsx`

| Element | Data | Status |
|---|---|---|
| Market cap, P/E, Relative Strength | `companies` merged onto `data.screenerStocks` by ticker — `rsRating` (from the new `rs-rating.job.ts`) overrides `relativeStrength` when available, feeding the existing RS 90+/70-90/<40 filter buttons and the "RS {n}" sparkline label unchanged | 🟡 Hybrid |
| Sales/EPS growth %, gross margin, RVOL, Tech Rating | `data.screenerStocks` — hardcoded. Still proprietary computed scores no vendor sells directly and no computation exists for yet | 🔴 Static |
| Per-row sparkline / chart (`stock-panel.tsx`) | Real bars via `useChartBars` — `ChartCard` now passes `realBars`; previously `genOHLC()` synthetic despite the bars already being in Firestore | ✅ Live |
| Filter/preset logic | Unchanged, operates on the merged list above | ✅ Live inputs, static logic |

`rs-rating.job.ts` is an independent, from-scratch approximation of an IBD-style relative-strength score (most-recent-quarter-weighted trailing returns from real `ohlcv_bars`, ranked 1-99 within `TICKER_UNIVERSE`) — not the literal proprietary IBD formula, and it writes nothing meaningful until `stock-history.job.ts` has accumulated enough real bar history first.

---

## IPOs (`/menu/ipos`) — `screens/ipos.tsx`

| Element | Data | Status |
|---|---|---|
| "Live IPO Calendar" card (new) | New, additive `ipos` (Finnhub) card — real recent/upcoming IPOs (date, name, symbol, exchange, price, status), shown once the collection has synced data | 🟡 Hybrid |
| Stats strip, Recent IPO Performance table, Upcoming Pipeline table | Hardcoded (`RECENT_IPOS`, `PIPELINE`) — untouched. Finnhub's calendar has no current trading price or day-1 return, so it can't be merged into these return-calculation rows; a brand-new IPO ticker also generally isn't in `companies` yet either | 🔴 Static |

FMP's `ipos-calendar` is still confirmed restricted on the current plan, but Finnhub's IPO calendar turned out to be a genuinely separate endpoint from its blocked economic calendar (verified 2026-07-07 with a real call) — so this screen is no longer vendor-blocked at all.

---

## Themes (`/menu/themes`) — `screens/themes.tsx`

| Element | Data | Status |
|---|---|---|
| Theme membership (which 7-8 tickers per theme) | `THEMES` — hardcoded; this is curated editorial grouping, the same category as Screener's named presets, not vendor data | 🔴 Static |
| Per-stock price / % change | `companies` merged onto each theme's stock list by ticker, with a "live" count shown per theme | 🟡 Hybrid |
| Per-stock chart (`stock-panel.tsx`) | Real bars via `useChartBars` — was `genOHLC()` synthetic | ✅ Live |

---

## Portfolio Pulse (`/menu/portfolio`) — `screens/portfolio.tsx`

| Element | Data | Status |
|---|---|---|
| Demo holdings + shares (when signed out, or before any real holdings exist) | `data.folio` + `DEFAULT_SHARES` — hardcoded, exactly as originally designed | 🔴 Static |
| Real holdings (once a signed-in user adds any) | Firestore `users/{uid}/portfolios/default/holdings/{ticker}` — takes over from the demo data automatically | ✅ Live |
| Price / % change on any holding, demo or real | `companies` merged in by ticker | 🟡 Hybrid |
| Per-holding chart (`stock-panel.tsx`) | Real bars via `useChartBars` — was `genOHLC()` synthetic | ✅ Live |
| "Import from photo" | Simulated OCR flow (`PARSED` fixed fake result) — restored as originally designed, not a real image-recognition integration | 🔴 Static |
| AI portfolio summary (drivers/leaders/laggards) | Computed client-side from the merged holdings above — real once the underlying prices are real | 🟡 Hybrid |
| Materialized portfolio summary (new, 2026-07-08) | `totalValue`/`dayPL`/`dayPLPct`/`holdingsCount` written (debounced ~3s) onto the `users/{uid}/portfolios/default` doc whenever holdings or live prices change meaningfully. Not read back by any screen — the UI stays purely live-computed for zero latency; this is a cache for future consumers outside the browser (notifications, a backend job, historical tracking) | ✅ Live |

---

## Watchlist (`/menu/watchlist`) — `screens/watchlist.tsx`

| Element | Data | Status |
|---|---|---|
| Demo watchlist (when signed out, or before a real list exists) | `data.watch` — hardcoded, exactly as originally designed | 🔴 Static |
| Real watchlist (once a signed-in user saves one) | Firestore `users/{uid}/watchlists/default` — takes over from the demo list automatically | ✅ Live |
| Price / % change on any watched ticker, demo or real | `companies` merged in by ticker | 🟡 Hybrid |
| Per-ticker chart (`stock-panel.tsx`) | Real bars via `useChartBars` — was `genOHLC()` synthetic | ✅ Live |
| AI watchlist summary | Computed client-side from the merged list above | 🟡 Hybrid |

---

## Stock Detail (`/menu/stock`) — `screens/stock.tsx`

| Element | Data | Status |
|---|---|---|
| Price, % change, market cap, P/E, dividend yield, beta, sector | `companies` merged in at a single point (`data` object), flowing through the whole page — tagged with a "live quote · Polygon" pill when live. **`peers` and `dividendYield` are now populated** by `polygon-company-profile.adapter.ts`; both were previously declared FIELD_NOT_SUPPORTED, which was wrong on both counts (see the two rows below) | 🟡 Hybrid |
| Candle chart — **all 7 timeframes** (1D/1W/1M/3M/6M/1Y/5Y) | `app/iq/hooks/useChartBars.ts`. Intraday (1D/1W/1M) reads `intraday_bars/{ticker}_{5min\|30min}` — **one doc per ticker/resolution holding an array of bars**, not a doc per bar — written by `intraday-bars.job.ts`. 3M/6M/1Y/5Y read `ohlcv_bars`, now backfilled to a full **5 years** (299,552 docs) rather than ~300 days. Tagged "live · Polygon" | ✅ Live *(474 intraday docs, ~395k bars)* |
| RSI pane series, MA/EMA ladder (10/20/30/50/100/200), VWAP, 52-week high/low, average volume (20/50) | `technical-indicators.job.ts` → `companies`. Previously all fabricated: the RSI pane was a seeded sine walk, the MA ladder was price multiples, VWAP was `p * 0.994`, the 52-week range was `p * 0.58 … p * 1.02`, and average volume was market cap ÷ price × a constant. VWAP is now the vendor's own `vw` persisted per bar | ✅ Live *(241/241)* |
| Peers list | Polygon `/v1/related-companies/{sym}` via `companies.peers` — real peers, not the old sector-filtered mock. **225/241 covered**; the 16 blanks are foreign issuers and ADRs for which the endpoint genuinely returns nothing, and those fall back to the sector-filtered list | 🟡 Hybrid |
| Dividend history card + drawer, dividend yield | `dividend_history/{ticker}` via `app/iq/hooks/useDividendHistory.ts` — full payment history, annual totals, TTM total, derived yield, 5-year CAGR, increase streak. Replaces a 10-year extrapolation from a single payment. **Yield is 176/241**, and the 65 nulls are correct, not missing: 57 are genuine non-payers and 8 are lapsed payers with real but stale history (ADBE, ADSK, INTC, MELI, PARA, PDD, S, STLA), which now render "Dividend suspended" with the last payment date instead of borrowing the mock's number | ✅ Live *(241/241 history)* |
| Split history | `splits/{ticker}` via `app/iq/hooks/useSplits.ts` (`splitRatio`, `splitsSince`) — written by `corporate-actions.job.ts`. Never synced before this pass | ✅ Live *(241/241)* |
| Balance sheet + cash flow, margins, current ratio | `financials.job.ts` → `companies`. Same `/vX/reference/financials` call the income statement already used — these fields were being fetched and then discarded, so the UI fabricated them | ✅ Live *(226 tickers)* |
| AI thesis, AI risk, confidence score | `data.stockInfo` — hardcoded (needs Claude) | 🔴 Static |
| Recent news / insider activity (in the AI panel) | `data.stockInfo[sym].news` / `.ins` — hardcoded (separate from the real `insider_transactions` feed used on the Insider screen) | 🔴 Static |
| Chart notes (save / load / delete) | Firestore `stock_comments` — written/read directly via the client SDK | ✅ Live *(the feature was built, but `stock_comments` had **no Firestore rule**, so default-deny blocked it silently until the 2026-07-22 rules fix)* |

The same `useChartBars` path feeds `app/iq/stock-panel.tsx`, which is the chart embedded in **Screener, Watchlist, Portfolio and Themes** and in Movers' sliding drawer. Those four screens' charts were 100% synthetic — not because the bars were missing, but because `ChartCard` never passed `realBars` through. They now read the same real bars with no new sync work.

One trap worth recording: **raising the backfill depth constant did nothing on its own.** `sync_watermarks.lastSyncedThrough` only ever advances forward, so an already-synced ticker asks for `watermark + 1 day` and never reaches newly-available *older* history — the 5Y chart would have stayed synthetic while the build, the types and the tests all passed. `stock-history.job.ts` now also tracks `earliestSyncedFrom` and fills backwards to the plan's rolling 5-year edge. Any future depth increase must do the same.

---

## Options Chain (`/menu/options`) — `screens/options.tsx`

| Element | Data | Status |
|---|---|---|
| "Live Options Reference" card | Additive `options_chains` (Polygon) card — real strikes/expirations for the currently-selected ticker, shown only when it's in the curated `OPTIONS_UNIVERSE` (8 tickers: AAPL, MSFT, NVDA, TSLA, AMZN, META, SPY, QQQ) and has synced data. **Now carries full per-contract OHLC, VWAP, trade count and range %**, not just last close and volume — `/v2/aggs/ticker/O:{contract}/range/1/day/…` is authorized on this plan even though the options *snapshot* is not | 🟡 Hybrid |
| Full chain (strike, bid/ask, last, IV, volume, OI, ITM flag) | `buildChain()` — deterministic seeded pseudo-random generator, untouched. **Last and volume are the two columns that could be filled from the per-contract aggregates above**; bid/ask, IV and OI cannot | 🔴 Static — **not just unwired**: Polygon's options snapshot and NBBO quotes are confirmed 403 NOT_AUTHORIZED on the current plan (re-verified 2026-07-21), so real bid/ask/IV/OI genuinely aren't available without a plan upgrade or a Tradier key |
| Greeks (delta/gamma/theta/vega) | Not computed or displayed at all currently | 🔴 Static (not built) |

Two further vendor paths are still scaffolded but inert if real bid/ask/greeks are wanted later: `backend/src/vendors/tradier/tradier.service.ts` (needs `TRADIER_ACCESS_TOKEN`, currently empty) and `backend/src/vendors/unusual-whales/unusual-whales.service.ts` (needs `UNUSUAL_WHALES_API_KEY`, currently empty, covers `options_flow`/`block_trades` instead).

---

## Insider & Institutional (`/menu/insider`) — `screens/insider.tsx`

| Element | Data | Status |
|---|---|---|
| Insider transaction feed | Real `insider_transactions` (SEC Form 4) rows tagged "live", concatenated with the original mock feed | 🟡 Hybrid |
| "Live overlap (CUSIP-matched, real)" section (new) | `fund_holdings/{cik}/filings/{accessionNumber}/positions` — exact CUSIP cross-referencing across real 13F filings, shown alongside (not replacing) the original mock cross-fund cards | ✅ Live |
| Fund cards, AI insight blurbs, cross-fund mock cards, institutional holders/mutual funds tables | `data.funds` / `AI_SECTIONS` / `CROSS_OWN` etc. — hardcoded, fully intact | 🔴 Static |

---

## Commentary (`/menu/commentary`) — `screens/commentary.tsx`

| Element | Data | Status |
|---|---|---|
| Live tab | Real `news` docs merged in ahead of the original mock `commentary` items. Polygon-primary as of 2026-07-08 — carries per-ticker `sentiment`/`sentimentReasoning`/`keywords` (null/empty on Finnhub fallback) | 🟡 Hybrid |
| Premarket / After Hours / My names / Macro tabs | Real `news` filtered by ET hour or ticker, appended to the corresponding original mock arrays (`PREMARKET`, `AFTERHOURS`, etc.) | 🟡 Hybrid |
| Premarket / after-hours **price moves** (previously hardcoded lines) | `app/iq/hooks/useExtendedHours.ts` → `GET /live/snapshot`, backed by Polygon **`/v3/snapshot`** (the cache moved v2 → v3), which carries `early_trading_change_percent` / `late_trading_change_percent` / `regular_trading_change_percent` / `market_status` | ⚠️ Live locally, **renders nothing in production** — this is one of the two HTTP-served surfaces the browser can't reach (see the note at the top); it fails silently by design |
| NewsDrawer (per-ticker history) | Live `news` section shown above the original mock `buildNewsHistory()` narrative section — both present | 🟡 Hybrid |
| "Before the Bell" / "General perspective" sidebar cards | Hardcoded | 🔴 Static |

---

## Recaps (`/menu/recap`) — `screens/recap.tsx`

| Element | Data | Status |
|---|---|---|
| Everything (index cards, news briefing, key stories, sector heatmap, movers, internals) | Hardcoded | 🔴 Static — **blocked**: needs a new Polygon-EOD-recap sync job plus `ANTHROPIC_API_KEY` for the narrative; neither exists yet |

---

## Macro & VIX (`/menu/macro`) — `screens/macro.tsx`

| Element | Data | Status |
|---|---|---|
| "Live Economic Indicators" card (CPI, unemployment, payrolls, Fed funds, 10Y yield, etc.) | New, additive `macro_events` (FRED) card — shows only once the collection has synced data; doesn't touch the calendar below | 🟡 Hybrid |
| "Live Dividend Calendar" card | Additive `dividends` card (Polygon-primary as of 2026-07-12, FMP fallback) — real upcoming ex-dividend dates, pay dates, amount, frequency across the whole market. **Correction to the 2026-07-12 note above: yield is no longer null on Polygon-served rows.** Polygon has no dividend-*yield* field, but the yield is *derivable* — `dividend_history/{ticker}` (via `useDividendHistory`) supplies a TTM-sum ÷ price yield, annualized per calendar row, with no FMP fallback needed | 🟡 Hybrid |
| Dividend history / 10-year payment record on the per-stock view | `dividend_history/{ticker}` — real payment rows, annual totals, 5-year CAGR and increase streak, replacing a 10-year extrapolation | ✅ Live *(241/241)* |
| Market regime card, VIX card, Last/This/Next Week economic calendars, Dividend calendar (chip grid/month view), VIX Sensitive Stocks table | Hardcoded | 🔴 Static — the economic calendar tabs are a fixed illustrative "today" (fictional dates), not a real date range, so live FRED readings aren't force-fit into them; see the note above `MacroEventsJob` for why |

---

## Admin Console (`/admin`) — `app/admin/page.tsx` + `public/admin/console.html`

New as of 2026-07-22. The console is a standalone static page rendered inside an iframe; `app/admin/admin-data.ts` reads Firestore in the React parent and stages the dataset in `sessionStorage` **before** the iframe mounts, so the console's existing ~600 lines of rendering code paint real numbers without being rewritten. Writes go the other way, over `postMessage` — the iframe has no Firebase SDK, so the parent (which holds the admin session) performs them.

Access is `isAdmin()` = `token.admin == true` **OR** `token.email == ADMIN_EMAIL`. It deliberately does **not** require `email_verified`: the admin is a password account with `emailVerified=false`, and requiring it locked the admin out of Firestore while the backend guard still admitted the same account.

**Staff accounts are excluded from every metric.** The admin is not a customer — counting it adds a phantom user, shifts the plan mix, drags ARPU down and changes the churn denominator. At this user count one staff row moves headline numbers by 20%+, so this is correctness, not cosmetics.

| View | Data | Status |
|---|---|---|
| Overview KPIs | `users` + `plans` + `payments`, computed in `admin-data.ts` | 🟡 Hybrid — user/plan figures real; revenue tiles read 0 because `payments` is empty |
| Users | Real `users` docs joined to their effective plan | 🟡 Hybrid — identity/plan/status real; the engagement columns (watchlists, holdings, API calls, alerts) are **0, not estimated** — no collection backs them yet |
| Subscriptions | `subscriptions` (backend `subscriptions.service.ts` computes the *effective* subscription — **expiry is computed, never trusted**, since nothing rewrites a user doc when a subscription lapses; falls back to FREE, never to no-access) | 🔴 Empty — the collection has no documents, because nothing writes subscriptions yet (see Stripe below) |
| Per-plan entitlement editor | `plans/{id}.featureFlags`, toggled optimistically and reverted if the parent reports failure. Firestore rules allow admin to update **`featureFlags` + `updatedAt` only** — price, currency and cycle stay server-only, because a client that could rewrite `amount` could set a plan to $0. Create/delete denied. `adminDashboard` and `userManagement` are shown but **locked**: selling them would be privilege escalation | ✅ Live *(3 plans)* |
| Revenue | `revenue_summary` / `payments` | 🔴 Empty — **the fabricated trend deltas and the fake MRR history chart are now suppressed when running on real data**, rather than being carried forward as if authoritative |
| Usage & API | `api_usage` | 🔴 Empty — the collection is specified but **not implemented**; no middleware records API calls, so every KPI here reads 0 |
| Feature adoption | `feature_adoption` — real per-user, per-feature open counts written by the client (48 tracked features) | 🟡 Hybrid — ~12 rows seeded so far |
| Monitor | Embeds the backend ops UI over HTTP | ⚠️ **Non-functional in production** — same backend-unreachable problem as the market-status pill |
| Social Studio | Static | 🔴 Static |

**Plans, as seeded in Firestore** (`plans.registry.ts` → `plans.service.ts`, merge-based so operator edits to `featureFlags` survive a re-seed). Amounts are **minor units — 4999 = $49.99**:

| id | name | amount | cycle | entitlements |
|---|---|---|---|---|
| `free` | Free | 0 | none | 8/30 — marketCatalyst, news, scanner, heatmap, macro, ipos, chartsDaily, watchlist |
| `plus` | Plus | 2999 | monthly | 20/30 — adds chartsIntraday, chartsHistory, chartIndicators, chartNotes, technicalRatings, dividendHistory, peers, earningsDetail, portfolio, screener, themes, alerts |
| `pro` | Pro | 4999 | monthly | 28/30 — adds fundamentalRatings, ownership, optionsChain, exportData, apiAccess, aiAssistant, backtesting, paperTrading |

Pro is 28/30 rather than 16/16 because `adminDashboard` and `userManagement` are staff-only and false on every plan.

Backend surface: `GET /plans`, `POST /plans/seed` (admin), `GET /users/:uid/entitlements`, and the admin-guarded `GET /admin/users`, `GET /admin/subscriptions`, `GET /admin/revenue`.

> **Firestore rules note.** Both repos ship a `firestore.rules`, and they have **drifted**. The live ruleset is deployed from **MarketCatalystUI/firestore.rules**; the backend copy is stale and now carries a DO-NOT-DEPLOY header. `feature_adoption` is the only client-writable analytics collection, and is constrained accordingly — the row must belong to the caller, `openCount` may only increase, ownership cannot change, delete denied.

---

## Summary (updated 2026-07-22)

| Category | Screens |
|---|---|
| ✅ Fully live (no mock fallback in normal operation) | Stock notes (`stock_comments`); real user watchlist/portfolio once saved; **Stock Detail's charts across all 7 timeframes, RSI series, MA/EMA ladder, VWAP, 52-week range, dividend + split history**; **Dashboard Fear & Greed**; **US10Y**; **the admin console's plans/entitlement editor and feature-adoption view** |
| 🟡 Hybrid (live data merged onto intact original mock UI) | Dashboard (all 3 mini-widgets now included), Earnings Hub, Market Movers, Market Heatmap, Analyst Actions (partially), Screener (market cap/P-E/RS live, charts now real), Themes, Portfolio Pulse, Watchlist, Stock Detail (price/fundamentals, peers 225/241, dividend yield 176/241), Insider & Institutional, Commentary, Macro & VIX (Live Economic Indicators + Live Dividend Calendar cards, yield now derived), IPOs (Live IPO Calendar card), Options Chain (Live Options Reference card + per-contract OHLCV, curated 8-ticker universe only), shell ticker strip, shell Cmd+K search (full-market ticker search), Admin Console |
| 🔴 Fully static, blocked on vendor plan/key | Recaps (needs Claude + a new job); Options Chain's main bid/ask/IV/greeks/OI table (needs a Polygon plan upgrade or a Tradier key); Analyst Actions event table/Earnings guidance-reaction/richer News (need Benzinga); SPX/NDX/DJI/RUT/VIX spot values (Polygon Indices add-on — the tiles stay ETF proxies and are labelled as such) |
| ⚠️ Built and correct, but dead in production | Market-status pill, extended-hours moves, admin **Monitor** tab — all three call the backend over HTTP and the browser can't reach it (`NEXT_PUBLIC_BACKEND_URL` unset). Each degrades silently by design, so nothing looks broken; that is precisely why this needed checking rather than assuming |
| 🔴 Specified but not implemented | `api_usage` (no middleware records API calls, so the admin Usage & API KPIs read 0); per-user engagement columns in the admin console; Stripe checkout/webhooks — **no Stripe code exists in either repo**, so `payments` and `subscriptions` are empty |

---

## What would close the remaining gaps

| Gap | What's needed |
|---|---|
| **Every ✅ row above going stale** | **No Cloud Scheduler jobs exist in any region**, and there is no `scheduler-invoker` service account — `create-scheduler-jobs.sh` was never run. With `min-instances=0` the in-process `@Cron` decorators never fire, so **no sync job has ever run automatically in production**; all current data came from manual runs. This is the single highest-priority operational gap |
| Market-status pill, extended-hours moves, admin Monitor tab | Set `NEXT_PUBLIC_BACKEND_URL` and add a Firebase Hosting rewrite → Cloud Run. **This is a security decision, not a config tweak**: Cloud Run runs `--no-allow-unauthenticated` and `AdminGuard` relies on that, so making the service reachable **must** be paired with `ADMIN_GUARD_TRUST_IAM=false` or `/sync/:job/run`, `/purge` and `/retention` become world-callable |
| Payments / subscriptions / revenue in the admin console | **Stripe is not integrated — no Stripe code exists in either repo.** Checkout and webhooks are additionally blocked on the backend-unreachable gap above |
| Admin "Usage & API" KPIs | `api_usage` is specified but unimplemented — needs middleware that records API calls |
| `POLYGON_API_KEY` rotation | Still un-rotated (it was exposed in chat). Secret Manager version 4 is enabled. `deploy/rotate-polygon-key.sh` automates everything except generating the replacement key in the vendor dashboard |
| Macro & VIX's live card | `FRED_API_KEY` is already set — just restart the backend (`npm run start:dev`) and `POST /sync/macro-events/run` once |
| IPOs' live card | Code is done (no key needed, Finnhub's already active) — just restart the backend and `POST /sync/ipos/run` once |
| Options Chain's live card | Code is done (no key needed, Polygon's already active) — just restart the backend and `POST /sync/options-chains/run` once |
| Macro & VIX's dividend card | Code is done (no key needed; Polygon-primary as of 2026-07-12, FMP fallback) — just restart the backend and `POST /sync/dividends/run` once |
| ~~Stock Detail's real chart~~ | **Closed 2026-07-22** — all 7 timeframes now real. Jobs are cursor-batched (40–60 of 241 tickers per run), so full coverage took 4–7 runs each; the whole sequence ran in dependency order (bars → intraday → companies → corporate-actions → indicators → statements) in ~2h20m |
| ~~Screener's real RS Rating~~ | **Closed** — 241/241, 0 skipped |
| **Options Chain's real bid/ask/IV/greeks/OI — highest-value remaining gap** | Either upgrade the Polygon plan, or get a free `TRADIER_ACCESS_TOKEN` and finish the existing `tradier.service.ts` stub |
| Recaps | Build a Polygon-EOD-recap job + obtain `ANTHROPIC_API_KEY` |
| Analyst Actions event table, Earnings session/guidance/reaction | Need a Benzinga key (`BENZINGA_API_KEY`, currently empty) |
| News category tagging + real-time push | News itself upgraded to Polygon-primary 2026-07-08 (sentiment/reasoning/keywords, no key needed) — only per-firm category tags and sub-minute push still need Benzinga |

See `Doc/openapi.yaml` for the full, per-endpoint version of this table (`x-status`, `x-primary-source`, `x-alternate-source`, `x-fallback-behavior`).
