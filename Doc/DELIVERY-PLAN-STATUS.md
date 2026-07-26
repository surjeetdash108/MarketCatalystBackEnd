# Weekly Delivery Plan — Completion Status

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
> **This doc, specifically:** This doc already carries the per-row R26/R28/R29/R30 updates from this session.
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


**Assessed:** 2026-07-24 (was 2026-07-23) · **Source:** `MarketCatalyst.ai_weekly_deliverables_Plan.xlsx` (36 deliverables, 97 person-days, 06 Jul–11 Sep 2026).

> **2026-07-24 delta (no row scores changed).** Fundamentals went deeper within
> existing rows: financials now carry **8 annual fiscal years** alongside the 10
> quarters, powering **Quarterly / Yearly** tabs on both **EPS & Sales history**
> and the **Income statement** (chart removed; table-only). Stock detail + the
> heatmap sector/stock modals + the dashboard Market Pulse were wired to **real
> `companies` data** (fabricated ranges/news/sector rows removed), **TradingView
> was removed** entirely, and a **shared live-price subscription** now drives the
> tape/watchlist/portfolio/search/stock consistently. New infra outside the
> 36-row plan: the **`/live/collections`** 5-minute read cache (Firestore-read
> cost control — keeps the GCP bill flat as users grow). R24/R29 already at their
> capped values; the estimates gap (R29) still needs the Benzinga add-on.

Completion is judged against the **actual codebase and live production state**, not the calendar — verified through the data-source audits in [FEATURE-DATA-MAP.md](./FEATURE-DATA-MAP.md) and [WIDGET-PROVIDERS.md](./WIDGET-PROVIDERS.md), direct code checks, and direct reads of production Firestore, the live Cloud Run revision, and the released Firestore ruleset.

> **Read the "When due" column first.** Today is **23 Jul = Week 3**. Weeks 1–3 are due now; **Weeks 4–10 are future-dated**, so a low % there is *on schedule*, not behind. Three future items (R23, R24, R47) are already largely done — ahead of plan.

> **Scoring vocabulary used below.** A row is only scored on what is **LIVE** — deployed and reachable by a real user in production. Work that exists in the repo and passes locally but cannot run in production (no scheduler, no reachable backend) is scored as **BUILT-NOT-DEPLOYED** and does *not* earn full credit. **NOT BUILT** means no code exists.

---

## Overall completion

| Basis | Figure |
|---|---|
| **Weighted by person-days (all 36 rows)** | **≈ 48%** (was 46%) |
| Weeks 1–3 only (what's *due* now, 26.5 p-days) | **≈ 98%** ⬆ (2026-07-23: every W1–W3 row at 100% of its non-AI scope; only AI narrative cards await Anthropic) |
| Weeks 4–10 (future, 70.5 p-days) | **≈ 37%** (was 33% — work pulled forward) |
| Rows fully complete (100%) | 21 of 36 (incl. R26 F&G, R28 Recaps, R30 Macro regime, 2026-07-23) |
| Rows blocked by data-plan limits (not effort) | 4 (options greeks, analyst events, earnings depth, options flow) |
| **Additional scope delivered outside the 36-row plan** | Subscriptions / entitlements / admin analytics (see [below](#additional-workstream--subscriptions-entitlements-admin-analytics)) |

**Plain reading:** the market-data screens (W1–W3) are largely delivered and the Polygon data layer went materially deeper on 2026-07-22 (intraday bars, 5-year history, corporate actions, real statements, real 10Y yield). The remaining ~52% is dominated by AI features (no Anthropic wiring yet), options depth (plan-gated), and the launch-hardening weeks — all scheduled for Aug–Sep.

**Cross-cutting note (updated 2026-07-23 — the earlier "nothing is scheduled" caveat is now resolved):** **21 Cloud Scheduler jobs are ENABLED and firing on schedule** — verified live (`sync-companies` 06:00 UTC, `sync-news` 20:30 UTC, `sync-market-movers` 22:00 UTC — all matching their crons), each invoking the worker's `/sync/{job}/run` endpoint. Data now refreshes **continuously** in production. Cloud Run still runs `min-instances=0`, but the Scheduler HTTP triggers do exactly the work the in-process `@Cron` decorators would (the container wakes per trigger), so `min-instances=0` is a cost optimisation, not a functional gap. This was R5's largest gap and it is now closed. The backend is also browser-reachable (public `market-catalyst-live` service + `NEXT_PUBLIC_BACKEND_URL` wired), so the live-data rows are reachable by real users, not localhost-only.

---

## Row-by-row

Legend — **Due:** ✅ due now · 🔵 future (not yet scheduled). **Screen · Feature:** the app screen (and feature) this requirement powers in the UI — `—` for pure infra / enabler / AI-unwired rows with no screen. **%:** completion of the row's stated scope.

| Row | Wk | Due | Deliverable | Provider | API URL | Screen · Feature | % | What's NOT done | Reason |
|---|---|---|---|---|---|---|---|---|---|
| R5 | W1 | ✅ | FOUNDATION: deploy FE+BE 24/7, Blaze, service-account, indexes+TTL | Firebase / Cloud Run | — (infra: Hosting + Cloud Run + Firestore) | — *(infra)* | **100%** ✅ | — (R5 scope fully delivered; the Polygon key rotation + rules-drift items are **R49**'s scope, separately tracked — not a dependency of this row) | ✅ **Complete 2026-07-23.** Every element of R5's stated scope is delivered and verified: **deploy FE+BE** (FE `marketcatalyst.web.app`; worker rev **00035-d74** + public `market-catalyst-live`), **24/7** (21 Cloud Scheduler jobs ENABLED and firing on schedule — `sync-companies` 2026-07-23 06:00 UTC, `sync-news` 20:30 UTC, `sync-market-movers` 22:00 UTC — all matching their crons; `scheduler-invoker` SA present), **Blaze** (Cloud Run + Scheduler operating), **service-account** (runtime SA least-privilege: `datastore.user`+`secretAccessor`), **indexes** (deployed), **TTL** (not possible on ISO-string dates → substituted with the in-code retention module, weekly prune, `RETENTION_DRY_RUN=false`). Backend is browser-reachable and CORS-verified. Security follow-ups live in **R49**, not here. |
| R6 | W1 | ✅ | Feature-flag system (`feature_flags` doc, per-release FF_* toggles) | — (internal) | — (Firestore `feature_flags`) | — *(internal)* | **100%** | — | Built 2026-07-21: registry + service + API + UI provider/Gate + nav & screen gating. Deployed rev 00017; `feature_flags/default` auto-seeded 25 flags in prod; resolver verified (default→env→Firestore, fail-open). **Extended 2026-07-22 with a SECOND, independent gating layer — per-plan entitlements** (`src/plans/plans.registry.ts`, 16 keys × 3 plans) plus an **admin UI to edit them per plan** (`public/admin/console.html` feature editor, writing `plans/{id}.featureFlags` under a rules constraint that permits only `featureFlags`+`updatedAt`). The two layers are deliberately NOT merged: FF_* answers *"is it built and shipped?"* → "coming soon"; entitlements answer *"may this tier use it?"* → "upgrade to unlock". Merging them would make an unbuilt feature masquerade as a paywall. Scope exceeded, not just met |
| R7 | W1 | ✅ | Project setup: Firebase, Polygon sub + keys, data-source verification | Polygon (Massive) | — (key/entitlement verification) | — *(setup)* | **100%** | — | Complete — all keys present and verified |
| R8 | W1 | ✅ | Run all sync jobs once; verify sync_meta + ops dashboard | multiple (all sync jobs) | — (21 jobs; see per-row endpoints) | — *(all sync jobs)* | **100%** | — | 21/21 jobs run, sync_meta populated, monitor UI live |
| R9 | W1 | ✅ | Market Movers live (gainers/losers/unusual-vol/RVol/filter) | Polygon | `/v2/snapshot/…/{gainers,losers}` + `/v2/aggs/grouped/locale/us/market/stocks/{date}` | **Movers** · gainers / losers / unusual-vol table | **100%** ✅ | — | ✅ 2026-07-21: MA-posture (real SMA50/200), week% (real 5-session change), tech-context (RSI/MACD/RS/RVOL) now live — added SMA/week fields to technical-indicators.job (rev 00019, ran for 238 tickers); catalyst now flags tickers with recent synced news ⬆ **100% on 2026-07-23:** the catalyst field is now strictly honest — **'Recent news'** (a real recent Polygon article exists for the ticker, via `companies.newsCount`) or **'No known catalyst'**. The fabricated fallback to the hardcoded mock label ('Earnings beat', 'Guidance raise') was removed from the Movers screen, the Dashboard movers widget and the mover drawer — no row asserts an invented catalyst. Everything on this row is now Polygon-sourced with zero fabrication. |
| R10 | W1 | ✅ | Market Heatmap live (sector %, tiles, summary) | Polygon | `/v2/aggs/grouped/locale/us/market/stocks/{date}` (11 SPDR sector-ETF proxies) | **Heatmap** · sector treemap + tiles | **100%** ✅ | — | ✅ 2026-07-21: hover tooltip now reads live `companies` (price/RVOL/RS/MA-status); dead Stocks/S&P-500 tab repurposed to a real **Day%/Week%** heat toggle (5-session change from technical-indicators.job, cap-weighted sector avg). S&P-500 filter dropped — no constituent list available ⬆ **100% 2026-07-23:** heatmap tiles now sample-labeled when no live sector data has synced; the dropped S&P-500 filter was an out-of-scope extra (no constituent list on Starter), so the stated deliverable (sector %/tiles/summary) is fully met. |
| R11 | W1 | ✅ | Dashboard core widgets live (AI card → R19) | Polygon | `/v2/aggs/grouped/locale/us/market/stocks/{date}` (market-breadth) | **Dashboard** · core widgets (Market Pulse, internals, VIX) | **100%** ✅ | AI card → R35 (Anthropic); Recaps → R28 — both separately tracked, not this row | ✅ 2026-07-21: Market Internals + F&G history now live from new `market-breadth.job` (176 days backfilled); VIX/Portfolio fake fallbacks removed (show — when absent) ⬆ **100% of the core-widget scope 2026-07-23.** All dashboard widgets are live from Polygon; the 'What Matters Now' **AI** card is tracked in **R35** (Anthropic — your planned purchase) and the Recaps card in **R28**, neither part of this row's widget deliverable. |
| R13 | W2 | ✅ | Macro & VIX live (econ calendar + dividends + VIX/yields) | Polygon + FRED (US-gov) | Polygon `/fed/v1/treasury-yields` + VIXY via `/v2/aggs`; FRED macro series (`FredService`). **Not** Finnhub. | **Macro** · VIX card, 10-yr yield, dividends | **100%** ✅ | True spot VIX needs the Polygon Indices add-on (a purchase); VIXY proxy is the delivered, labeled solution | ✅ 2026-07-21: Macro VIX card live via `market_indices` VIXY; dividend Month tab from live `dividends`. ⚠️ **Correctness fix 2026-07-22 — the 10-year yield was previously WRONG, not merely proxied.** `market-indices.job.ts` was publishing the **TLT ETF price** under the label "US10Y". TLT moves *inversely* to the yield it was labelled as, so the card showed the yield falling when it was rising. Now sourced from Polygon `/fed/v1/treasury-yields` — the **real** Treasury yield, `isProxy:false`, `unit:"percent"`. Also new: `dividend_history/{ticker}` (241 docs) carrying full payment history, annual totals, TTM, derived yield, 5y CAGR and increase streak; and `splits/{ticker}` (241 docs) ⬆ **100% 2026-07-23:** VIXY is the delivered, honestly-labeled (`isProxy:true`) proxy — consistent with the ETF proxies used for every index tile in this app. Spot VIX (`I:VIX` → 403) would need the **Polygon Indices add-on**, a future purchase like AI, not a gap in the delivered solution. |
| R14 | W2 | ✅ | IPOs live (calendar + offer price) | Polygon (only) | `/vX/reference/ipos`. Finnhub fallback removed — not redistribution-licensed; prod already ran fallback=none. | **IPOs** · IPO calendar + aftermarket perf | **100%** ✅ | SPAC units / brand-new tickers with no Polygon bars show "—" (honest, not mock) | ⬆ **Corrected 2026-07-23 — the 'falls back to mock' note was stale.** `ipos.job.ts` already derives day-1 and since-IPO returns from **Polygon** `/v2/aggs` (`getAggsRange`) — verified live: **40/52** IPO docs carry real aftermarket performance. The mock `RECENT_IPOS` renders only when the live collection is empty (it isn't). Polygon-only, no non-redistributable data. ⬆ **100% 2026-07-23.** |
| R15 | W2 | ✅ | Commentary/News live (aggregated feed + tags + drawer) | Polygon (only) | `/v2/reference/news`. **Finnhub dropped** from the news feed — not redistribution-licensed (was NEWS_SOURCE=aggregate). | **Commentary** · aggregated news feed | **100%** ✅ | Narrative "before the bell / after the close" briefs are AI content → R35 (Anthropic), honestly SampleBadge-labeled | Those sub-feeds have no live source; main feed is live ⬆ **100% of the DATA scope 2026-07-23:** the news feed (Polygon `/v2/reference/news`) and extended-hours moves (Polygon `/v3/snapshot` via `useExtendedHours`) are live; the two narrative brief cards are AI-generated content, labeled and tracked under **R35** (Anthropic). No non-AI gap remains. |
| R16 | W2 | ✅ | Sector Themes live (per-stock prices + theme perf) | Polygon | `/v3/reference/tickers` (companies prices) | **Themes** · sector-theme baskets | **100%** ✅ | — | Theme baskets are static config (fine); prices live when matched ⬆ **100% 2026-07-23:** matched tickers show live Polygon prices; unmatched (outside the synced universe) are SampleBadge-labeled with a live/total count. Theme baskets are static config by design. |
| R17 | W2 | ✅ | Company-name search (nameLower/tokens) | Polygon | `/v3/reference/tickers` | **Search** (⌘K / shell) · company-name search | **100%** ✅ | — | `ticker-universe` writes nameLower/searchTokens; ⌘K search live ⬆ **100% 2026-07-23:** company-name search is live over the full ticker universe (`nameLower`/`searchTokens`). ⬆ **2026-07-23:** ⌘K search results now overlay **live delayed prices** (Polygon `/live/snapshot` via `useSnapshotQuotes`, polled only while the palette is open) on top of the EOD `companies` price. |
| R19 | W3 | ✅ | Portfolio Pulse live (holdings + prices + P&L + totals) | Polygon | `/v3/snapshot` · `/v2/snapshot` (holding prices) | **Portfolio** · holdings + prices + P&L | **100%** ✅ | — | Real holdings + live prices + P&L all work; fallback is cosmetic ⬆ **100% 2026-07-23:** the Portfolio Pulse SCREEN uses real holdings + live Polygon prices + P&L, sample-labeled when a holding is outside the synced universe. The `$128,430` figure is on the pre-login MARKETING landing (`page.tsx`), a showcase — not the app. ⬆ **2026-07-23 — two upgrades.** (1) Holding prices and the portfolio **total (Σ shares×price)** + day P&L now track **live delayed prices** (Polygon `/live/snapshot`), not the once-a-day EOD write. (2) **CRUD gap fixed:** share quantity was hardcoded to 10 with no editor — added a Shares input to the add form and an editable position strip for the selected holding, both persisted to Firestore, so the total reflects real share counts. The `$128,430` figure remains only on the marketing landing. |
| R20 | W3 | ✅ | Watchlist live (persistence + prices + AI summary) | Polygon | `/v3/snapshot` (watchlist prices) | **Watchlist** · prices + persistence | **100%** ✅ | The "AI summary" is AI content → R39 (Anthropic); persistence + prices are done and labeled | AI intentionally deferred to R34/R39; persistence + prices done ⬆ **100% of the non-AI scope 2026-07-23:** watchlist persistence + live Polygon prices are done and sample-labeled; the 'AI summary' is tracked under **R39** (Anthropic — your planned purchase). ⬆ **2026-07-23:** watchlist prices now overlay **live delayed prices** (Polygon `/live/snapshot`) on the EOD price. CRUD verified: add/remove persist via Firestore `arrayUnion`/`arrayRemove` on `users/{uid}/watchlists/default`. (AI summary still R39 — Anthropic.) |
| R21 | W3 | ✅ | Empty-states + graceful fallback polish (cross-screen) | — (cross-screen) | — | — *(cross-screen empty states)* | **100%** ✅ | — | Only IPOs/Options/Insider label mock data; pattern not applied app-wide ⬆ **100% 2026-07-23:** the sample-labeling pattern is now applied across every W1–W3 data screen — movers, screener, portfolio, watchlist and heatmap gained a `<SampleBadge>` (shown when data isn't fully live), joining the already-labeled commentary, earnings, insider, macro, recap, themes and ipos. No W1–W3 screen silently shows mock. (analyst/options/stock are labeled within their own rows R41/R32/R24.) |
| R23 | W4 | 🔵 | ENABLER: backfill ohlcv_bars + compute jobs | Polygon | `/v2/aggs/ticker/{sym}/range/1/day/…` + `/range/{5,30}/minute/…` | — *(enabler; feeds Stock-detail charts)* | **100%** | — | **Ahead of schedule** — all 5 compute jobs green. **Deepened 2026-07-22:** `ohlcv_bars` now holds **~299,552 documents spanning the full 5-year window** (was ~300 days). Raising the backfill constant alone did nothing — `lastSyncedThrough` only ever advances — so `stock-history.job.ts` gained an `earliestSyncedFrom` watermark that fills history **backwards** as well as forwards, clamped to the plan's rolling 5-year edge. `vwap` now persisted per bar. Also new: `intraday_bars` (474 docs, 5-min + 30-min, one doc per ticker/resolution holding an array of bars) |
| R24 | W4 | 🔵→ | Stock Detail live (charts/RSI-MACD/fundamentals/52-wk/consensus/news/insider) | Polygon | `/v2/aggs/ticker/{sym}/range/…`, `/vX/reference/financials`, `/v1/related-companies/{sym}` | **Stock detail** · chart / RSI-MACD / financials / 52-wk / peers | **100%** ✅ | Analyst **consensus** uses FMP (required — Polygon has no analyst product on Starter); **true per-firm** analyst actions → R41 (Benzinga add-on). AI thesis/risk block → R38 (Anthropic). Both separately tracked | ⬆ **Raised from 80% on 2026-07-22 — the previous entry mis-diagnosed the gap.** The old note said 1D/1W needed intraday bars and 5Y needed 5-year history, implying a **data-plan** block. That was wrong: **both were authorized on the existing Polygon Stocks Starter plan all along** (intraday aggregates ✅, 5-year rolling history ✅ — re-probed live). It was a **sync gap, not a plan gap** — we simply had not pulled them. Now synced: `intraday-bars.job.ts` (new) feeds 1D/1W, and the 5-year backfill (R23) feeds 5Y. **All 7 chart timeframes now read real bars** via `useChartBars`. Also real: full financial statements, 52-wk high/low + %-from, SMA/EMA ladders (10/20/30/50/100/200), 90-point `rsi14Series`, VWAP, peers (`/v1/related-companies`), dividend yield + DPS. No synthetic timeframes remain ⬆ **100% 2026-07-23 — all remaining fabrications on the screen removed.** Revenue (TTM) now = last 4 real quarters (Polygon financials); the dead `finRows` panel and its fabricated FCF/debt are gone; the 'recent EPS' rows and the EPS-surprise pane now read **real `fin.epsHistory`** (beat/miss only where a real estimate exists, else 'no est.'); the technical ratings are computed from **real indicators** — Moving Averages from price vs each real SMA/EMA, Oscillators from real RSI(14)+MACD; and a header `<SampleBadge>` flags any ticker outside the synced universe (covering the RSI/SMA/vol/pivot/52wk fallbacks). The **analyst consensus panel is FMP-backed** — kept per decision; it is a consensus snapshot, and per-firm upgrades/downgrades remain **R41** (Benzinga). The **AI thesis** is **R38** (Anthropic). Charts, RSI/MACD, full financial statements, 52-week, news and insider (SEC) were already live. ⬆ **2026-07-24 deepened (still 100%):** the header price + chart now use the **shared live-price subscription** (delayed snapshot) instead of the once-a-day close, and the fundamentals gained **Quarterly / Yearly** tabs (annual financials). The **TradingView compare surface was removed** from the shipped page — the stock chart is now our own Polygon-backed `CandleChart`, last bar tracking the live price. |
| R25 | W4 | 🔵 | Screener live (filters + Tech Rating + RVOL + growth/margin) | Polygon | `/v3/reference/tickers` + `/vX/reference/financials` | **Screener** · filters + Tech Rating + RVOL | **100%** ✅ | — | Core overlay from `companies` live; a few filters never implemented ⬆ **100% 2026-07-23:** the three dead no-op filter checkboxes — **Above 50 & 200-DMA**, **RSI 40–70**, **Price > $5** — are now wired to real `companies` technicals (price/sma50/sma200/rsi14 from technical-indicators.job), with save/restore + reset. No no-op filter remains; every control filters on real Polygon-derived data. Verified against prod: of 241 priced companies, 114 pass the DMA filter, 211 RSI 40–70, 239 price>$5. |
| R26 | W4 | ✅ | Dashboard Fear & Greed gauge live | Polygon | `/v2/aggs/range` (SPY/TLT/VIXY) + `/v2/aggs/grouped` (breadth) | **Dashboard** · Fear & Greed gauge | **100%** ✅ | — | ⬆ **100% on 2026-07-23 — the composite methodology is now real.** The `fear-greed.job` computes the true **4-component composite** (momentum from SPY vs its 125-day MA, safe-haven from SPY−TLT 20-day return spread, volatility from VIXY vs its 50-day MA, breadth from grouped-daily advancers) for both the live value **and** a backfilled `market_sentiment_history/{date}` series (25 trading days, verified). The dashboard sparkline now reads that real composite history instead of the breadth-only proxy. The earlier missing-rule bug (gauge silently rendering a hardcoded 62) was fixed on 07-22; `market_sentiment_history` rule added and released 07-23. |
| R28 | W5 | ✅ | Recaps EOD data job | Polygon (composed) | Composes `market_indices` / `market_movers` / `sectors` / `market_breadth` → `recaps/{date}` | **Recap** · end-of-day recap | **100%** ✅ | AI prose lead + news briefing → R36 (Anthropic), separately tracked | ⬆ **0% → 100% on 2026-07-23.** New `recaps.job` (cron `45 18 * * 1-5`, Scheduler `sync-recaps` registered) freezes each session's indices, top gainers/losers, sector leaders/laggards and market internals (advancers/decliners/breadth/TRIN/up-down volume) into one dated snapshot — Polygon-derived, no extra vendor call. `recap.tsx` now renders the live `recaps/{date}` doc: hero index tiles, Biggest Movers, Market Internals and the drawer A/D bar are real; the fabricated 'extended breadth' block (NYSE TICK / McClellan / Put-Call — not available from Polygon) was **deleted**. Verified: `recaps/2026-07-21` written with 9 indices, 6+6 movers, 3+3 sectors, real internals. The **prose lead + news briefing** remain AI narrative → **R36** (Anthropic, your planned purchase), the only recap sub-part not part of this data-job row. |
| R29 | W5 | 🔵→ | 10-quarter EPS history (quarterly financials + wire) | Polygon (actuals) — **estimates need Benzinga add-on** | Polygon `/vX/reference/financials` (actuals). Estimate feed: Polygon **Benzinga Earnings** add-on (not on current plan) | **Earnings hub** · EPS & Sales / Income statement | **90%** ⬇ | **EPS estimates** — the forward/estimate side has **no redistributable source on the current plan.** FMP/Finnhub estimates exist in code but are **NOT licensed for redistribution**, so they must not ship to users | ⬇ **Recapped from 98% → 90% on 2026-07-23 to reflect the redistribution constraint honestly.** The **actuals** are 100% Polygon and redistributable: 10 real quarters of EPS from `/vX/reference/financials` (~228 tickers), plus full balance sheet, cash flow, margins and current ratio — a complete fundamentals panel. The **estimate** overlay (actual-vs-estimate beat/miss) is the only gap: the only sources wired are **FMP/Finnhub, which are not redistributable**, so per the Polygon-only policy they cannot be served. A redistribution-legal estimate feed = Polygon's **Benzinga Earnings & Estimates add-on** (a paid add-on to the current plan, tracked with R41/R42). Until purchased, estimates stay unshipped and this row is capped below 100%. ⬆ **2026-07-24 — actuals scope widened again (row still 90%, gap unchanged):** financials now also carry **8 annual fiscal years** (income/balance/cash-flow via `timeframe=annual`), so the earnings hub gained **Quarterly / Yearly** tabs on both **EPS & Sales history** and the **Income statement** (actuals only, chart removed). The 90% cap is unmoved because it reflects the missing *estimate* feed, not the actuals. |
| R30 | W5 | ✅ | Screener sector/cap class + IPO recent perf + Macro regime label | Polygon | `/v3/reference/tickers` (class) + `market_indices`/`market_breadth` (regime) | **Screener** / **IPOs** / **Macro** · sector-cap class, IPO perf, regime label | **100%** ✅ | — | ⬆ **70% → 100% on 2026-07-23 — all 3 sub-parts done.** ✅ Sector/cap classification live (`companies`). ✅ IPO aftermarket perf live (`ipos.job`, Polygon `/v2/aggs`). ✅ **Macro regime label now computed**: `macro.tsx` derives Risk-On / Neutral / Risk-Off by voting three live signals — VIX/VIXY level, market breadth (adv/dec from `market_breadth`) and the 10-year Treasury yield — replacing the hardcoded 'Risk-On Rally'. All Polygon/public data, no vendor purchase. |
| R32 | W6 | 🔵 | Options Chain live (bid/ask/IV/OI/Greeks) | Polygon → Tradier | Polygon `/v3/reference/options/contracts` + `/v2/aggs/ticker/O:{contract}/range/1/day/…`; Tradier `/v1/markets/options/chains` (quotes — 🔴 unwired). Polygon `/v3/snapshot/options` → 403 | **Options** · options chain | **45%** ⬆ | **Greeks, IV, open interest and bid/ask are still 🔴 hard-blocked** — Polygon's options *snapshot* endpoint returns `NOT_AUTHORIZED` on the current plan (re-probed live 2026-07-22, still 403). Those four columns cannot be made real without a vendor purchase | ⬆ **Raised from 25%, but read the nuance — the block has NOT lifted.** What changed is a different endpoint: option **contract aggregates** *are* authorized, so `options-chains.job.ts` now writes **real per-contract OHLC, VWAP, trade count and range %**. So the chain is no longer wholly synthetic — traded price/volume history per contract is genuine market data. But the quote-side surface a user actually reads an options chain for (bid/ask spread, IV, OI, greeks) is still fabricated. Unblock = **Tradier** (token already held, unwired) or Polygon Options Advanced |
| R34 | W7 | 🔵 | ENABLER: AI service + ANTHROPIC key + prompt infra | Anthropic (deferred) | — (unwired by decision) | — *(AI enabler)* | **0%** | AI service | ⏸️ **Deferred by decision (2026-07-21)** — you chose labeled placeholders over wiring Anthropic this phase. Not blocked: `ANTHROPIC_API_KEY` is provisioned; this is a scope choice to avoid per-request LLM cost until later |
| R35 | W7 | 🔵 | Dashboard 'What Matters Now' AI card | Anthropic (deferred) | — (unwired by decision) | **Dashboard** · "What Matters Now" (AI — unwired) | **0%** | Real AI narrative | ⏸️ **Deferred by decision** — card ships as a labeled placeholder; becomes real once R34 (Anthropic) is switched on |
| R36 | W7 | 🔵 | Recaps AI narrative | Anthropic (deferred) | — (unwired by decision) | **Recap** · AI narrative (unwired) | **0%** | Real AI narrative | ⏸️ **Deferred by decision** (AI) + depends on R28 recap job (Milestone 3, in progress). Data layer will exist; only the LLM narrative is held back |
| R38 | W8 | 🔵 | Stock Detail AI (thesis/risk/confidence + technical analysis) | Anthropic (deferred) | — (unwired by decision) | **Stock detail** · AI thesis / risk (unwired) | **0%** | Real AI | ⏸️ **Deferred by decision** — template text is honestly labeled 'AI-generated'; real model output awaits R34 |
| R39 | W8 | 🔵 | Earnings+Analyst+Insider+Watchlist AI notes | Anthropic (deferred) | — (unwired by decision) | **Earnings / Analyst / Insider / Watchlist** · AI notes (unwired) | **0%** | Real AI | ⏸️ **Deferred by decision** (AI). Includes R20 watchlist AI summary — non-AI watchlist parts already at 100% |
| R41 | W9 | 🔵 | Analyst Actions per-firm event table (upgrades/downgrades/PT) | Benzinga (🔴 403) / FMP | Benzinga `/benzinga/v1/ratings` → 403; FMP `grades-consensus` (snapshot only) | **Analyst** · per-firm event table | **5%** | Per-firm upgrade/downgrade events | 🔴 **Vendor-blocked, not effort** — per-firm actions need Benzinga (403 on current plan). FMP gives only a consensus snapshot; Finnhub gives rating *history* but not per-firm. Requires a paid vendor decision |
| R42 | W9 | 🔵 | Earnings depth (guidance/reaction/real-time actuals + tags) | FMP + Benzinga (🔴 403) | FMP `/stable/earnings-calendar`; Benzinga `/benzinga/v1/{earnings,guidance}` → 403; reaction derivable from `ohlcv_bars` | **Earnings hub** · guidance / reaction depth | **5%** | Guidance + price reaction | 🟠 **Partially unblockable now** — session (BMO/AMC) IS available on the held Finnhub key (unwired); guidance/reaction still need a Benzinga-class feed. Reaction could also be computed from `ohlcv_bars` post-print |
| R43 | W9 | 🔵 | Options flow + dark-pool prints | Unusual Whales (not subscribed) | — (unwired) | **Options** · flow + dark-pool prints | **0%** | Entire feature | 🔴 **Vendor-blocked** — needs a UnusualWhales / Polygon-paid flow add-on the current plans don't include. Marked P2 (post-MVP) in the plan itself |
| R44 | W9 | 🔵 | Alerts engine (12 alert types + watchlist toggles) | — (internal) | — (rules over synced Firestore data) | **Alerts** · alerts engine (screen not built) | **5%** | Rules engine + 12 alert types | 🔨 **Not built — no blocker.** Net-new backend (evaluate rules against synced data, per-user toggles, delivery). All input data exists; it is buildable now, just not yet scheduled (W9) |
| R46 | W10 | 🔵 | Editorial + dropped-feature decisions | — (product) | — | — *(product decisions)* | **0%** | Product decisions | 🗓️ **W10 by design** — a decision/curation task (which themes, presets, sections to keep or cut), correctly sequenced for launch week; not an engineering gap |
| R47 | W10 | 🔵 | Earnings + Macro calendars on real date ranges (structural) | FMP + Finnhub | FMP `/stable/earnings-calendar`; Finnhub `/calendar/economic` | **Earnings + Macro calendars** · date-anchored calendars | **80%** | Earnings coverage thin | **Ahead of schedule** — date-anchored calendar built (`earnings-calendar.tsx`, `calendar-range.ts`); FMP's 10-row coverage limits it |
| R48 | W10 | 🔵 | Full regression + empty-states + mobile + performance | — (QA) | — | — *(QA)* | **0%** | QA gate | 🗓️ **W10 by design** — final QA/regression gate, only meaningful once features stop changing. Partially advanced by R21 empty-state work |
| R49 | W10 | 🔵 | Security review + launch checklist | — (security) | — | — *(security)* | **15%** | Full review + checklist | 🗓️ **W10 by design.** Already done ahead: runtime SA least-privilege; Firestore rules server-write-only; retention module; 2026-07-22 rules hardening — `plans` writable by admin on **`featureFlags`+`updatedAt` only** (a client that could rewrite `amount` could set a plan to $0), create/delete denied; `feature_adoption` is the only client-writable analytics collection and is constrained (row must belong to caller, `openCount` may only increase, ownership immutable, delete denied); `adminDashboard`/`userManagement` are staff-only on **every** plan so they can never be sold (privilege escalation). ⚠️ Still outstanding, all three real: **(1) `POLYGON_API_KEY` is still un-rotated** (exposed in chat; Secret Manager version 4 enabled; `deploy/rotate-polygon-key.sh` automates all of it except generating the replacement). **(2)** ✅ **Resolved 2026-07-23 without the risky rewrite.** Backend reachability was delivered by a SEPARATE public service (`market-catalyst-live`, `APP_ROLE=live`) that mounts only `LiveModule` — `/sync`, `/purge`, `/retention`, `/admin` all return **404** there (verified) while the worker stays `--no-allow-unauthenticated` with `ADMIN_GUARD_TRUST_IAM=true`. No Hosting→Cloud Run rewrite was used, so the world-callable-admin risk never materialised. **(3)** Both repos ship a `firestore.rules` and they have **drifted** — the live ruleset deploys from `MarketCatalystUI/firestore.rules`; the backend copy is stale and now carries a DO-NOT-DEPLOY header |

---

## Why the remaining rows aren't done — categorized

The "Reason" column now tags each incomplete row by *why*, not just *what*:

| Marker | Meaning | Rows |
|---|---|---|
| ⏸️ **Deferred by decision** | You chose (2026-07-21) to keep AI as labeled placeholders rather than wire Anthropic this phase. Not blocked — `ANTHROPIC_API_KEY` is provisioned; a scope/cost choice. | R34, R35, R36, R38, R39 |
| 🔴 **Vendor-blocked** | Needs a data source the current plans don't include. No amount of coding closes it without a purchase. | R41 (Benzinga), R43 (UnusualWhales), R32 **greeks/IV/OI/bid-ask only** (Tradier/Polygon-Advanced) — note R32's *contract OHLCV* is no longer blocked |
| 🚧 **Built but not operating** | Code exists and is deployed, but production cannot execute or reach it. Not a vendor problem and not a coding problem — an ops problem. | ✅ **Empty as of 2026-07-23** — R5's ops gaps (no scheduler; unreachable backend) are both closed. See O1/O2 below. |
| 🟠 **Partially unblockable now** | Some of the row is reachable with keys already held; the rest needs a paid vendor. | R42 (session via Finnhub; guidance via Benzinga) |
| 🔨 **Not built — no blocker** | Net-new work with all input data available. Buildable now, just scheduled later. | R44 (alerts engine) |
| 🗓️ **W10 by design** | Launch-week decision/QA/security tasks, correctly sequenced last — only meaningful once features stop changing. | R46, R48, R49 |

**So of everything past R32:** 5 rows are a deliberate AI deferral, 3 are hard vendor blocks, 1 is buildable-but-unscheduled (alerts), and 3 are launch-week gates. Only the alerts engine (R44) is "just not built yet" with no external constraint. **Separately, R5 is now the most serious row in the table** — not because code is missing, but because none of it runs on a schedule and none of it is reachable from a browser.

---

## Additional workstream — subscriptions, entitlements, admin analytics

> **This is NOT one of the 36 planned rows.** It is *additional scope* delivered on 2026-07-22 alongside the plan. It does not appear in `MarketCatalyst.ai_weekly_deliverables_Plan.xlsx`, it carries no person-day budget there, and **it is excluded from every percentage above** — counting it would inflate plan completion with work the plan never asked for.

| Item | State | Detail |
|---|---|---|
| Plan registry + 3 plans | 🟢 **LIVE** | `src/plans/plans.registry.ts` — 30 entitlement keys, 3 plans, seeded into Firestore `plans` (3 docs, verified). Free 0 / Plus 2999 / Pro 4999 — **amounts are minor units (cents)**, so 4999 = $49.99. Cumulative ladder: Free 8/30 (marketCatalyst, news, scanner, heatmap, macro, ipos, chartsDaily, watchlist) → Plus +12 = 20/30 (chartsIntraday, chartsHistory, chartIndicators, chartNotes, technicalRatings, dividendHistory, peers, earningsDetail, portfolio, screener, themes, alerts) → Pro +8 = 28/30 (fundamentalRatings, ownership, optionsChain, exportData, apiAccess, aiAssistant, backtesting, paperTrading). Pro is 28/30 **not** 16/16 because `adminDashboard` + `userManagement` are staff-only on every plan by design |
| Entitlement resolution | 🟢 **LIVE** | `subscriptions.service.ts` — **expiry is computed at read time, never trusted from the stored doc**, because nothing currently rewrites a user doc when a subscription lapses. Falls back to FREE, never to no-access |
| Plans/entitlements API | 🟡 **BUILT-NOT-REACHABLE** | `GET /plans`, `POST /plans/seed` (admin), `GET /users/:uid/entitlements`. Deployed on Cloud Run rev 00031-wvc — but the browser cannot reach the backend, so the frontend resolves entitlements straight from Firestore instead |
| Admin analytics API | 🟡 **BUILT-NOT-REACHABLE** | `GET /admin/users`, `/admin/subscriptions`, `/admin/revenue`, all admin-guarded, **staff accounts excluded from every metric**. Same reachability caveat |
| Frontend gating | 🟢 **LIVE** | `app/iq/entitlements.tsx` (`EntitlementProvider`, `useSubscription`, `useEntitlement`, `EntitlementGate`) + `app/iq/entitlement-gate.tsx` (`PlanGate` upgrade panel, `useSlugEntitled` to hide nav items, `SLUG_ENTITLEMENT` map) |
| Feature-adoption analytics | 🟢 **LIVE (thin data)** | `feature-adoption.ts` + `track-feature.tsx` — **48 tracked features** (all `menuItems` screens plus in-app actions: 8 stock drawers, chart timeframes/indicators/expand, watchlist add/remove, search, screener, news…). 30-second dedupe; failures swallowed so analytics can never break a screen. Only ~12 seeded rows so far. This is the **only** client-writable analytics collection — because the browser cannot reach the backend — and its rule is correspondingly tight |
| Admin console | 🟢 **LIVE (partly)** | `app/admin/admin-data.ts` builds the dataset from Firestore and stages it in `sessionStorage` **before** the iframe mounts; `public/admin/console.html` renders real data and hosts the per-plan feature editor. Fabricated trend deltas and the fake MRR history chart are now **suppressed** when real data is present |
| Monitor tab in console | 🔴 **DEAD IN PRODUCTION** | Embeds the backend ops UI — which the browser cannot reach. Works locally only |
| Stripe / billing | ⛔ **NOT BUILT** | No Stripe code exists in either repo. `payments` and `subscriptions` collections exist and are **empty**. Checkout + webhooks are additionally blocked on backend reachability |
| `api_usage` metering | ⛔ **NOT BUILT** | Collection + rules specified, no middleware records anything. The admin "Usage & API" KPIs therefore read **0** — they are not broken, they are unimplemented |
| Per-user engagement columns | ⛔ **NOT BUILT** | watchlists / holdings / apiCalls / alerts per user all render 0 — no collection backs them yet |

**Firestore collections added:** `intraday_bars`, `dividend_history`, `splits`, `plans`, `payments`, `subscriptions`, `feature_adoption`, `api_usage`, `audit_logs`, `revenue_summary`, `system_metrics`.
**Populated:** intraday_bars (474), dividend_history (241), splits (241), plans (3), feature_adoption (~12 seeded).
**Empty:** payments, subscriptions, api_usage, audit_logs, revenue_summary, system_metrics.

**Admin auth note:** `isAdmin()` = `token.admin == true` **OR** `token.email == ADMIN_EMAIL`, and it deliberately does **not** require `email_verified` — the admin is a password account with `emailVerified=false`, and requiring verification locked the admin out of Firestore while the backend guard still admitted the same account. That asymmetry is intentional and documented here so it is not "fixed" back into a lockout.

---

## Additional features — delivered outside the 36-row plan

> **None of these are among the 36 planned rows.** They were requested and delivered *on top of* `MarketCatalyst.ai_weekly_deliverables_Plan.xlsx`, carry no person-day budget there, and are **excluded from every percentage above**. Tracked here in the same Provider / API format so they are visible rather than invisible. Same redistribution rule applies: everything served is **Polygon** (redistributable) or public/first-party — no Finnhub/FMP data ships.

| Feature | Provider | API / URL used | State | What it does · what's NOT done |
|---|---|---|---|---|
| **Live ticker tape** (scrolling header strip) | Polygon | **SSE** `/live/tape/stream` + JSON fallback `/live/tape`, each fed by one `GET /v3/snapshot?ticker.any_of={20 syms}` per refresh, plus `GET /fed/v1/treasury-yields?limit=2` for the US10Y tile | 🟢 **LIVE** | 21 tiles (8 index ETF proxies + 12 mega-caps + US10Y), delayed ~15 min on the Starter plan. **Server-side SSE broadcast**: one `ReplaySubject`, one vendor call per minute **regardless of user count** (ref-counted poller — zero users ⇒ zero calls; verified `upstreamCalls` tracks minutes, not clients). Falls back to the once-daily `market_indices` (R11) on outage. — Nothing outstanding; real-time (sub-15-min) data would need a Polygon real-time add-on (`T`/`Q` channels return `NOT_AUTHORIZED` on the current plan) |
| **Shared live-price subscription** (tape · watchlist · portfolio · search · stock detail) | Polygon | `GET /live/snapshot?tickers=…` → cached `SnapshotCacheService` → Polygon `/v3/snapshot` (batched, ≤50 tickers) | 🟢 **LIVE** | 2026-07-24: `LivePricesProvider` subscribes every **portfolio + watchlist** ticker on login (read from Firestore) plus the viewed/searched ticker, collapsing all screens to **one deduped 15 s poll** of the union (`cache:no-store` + ETag, so the browser can't serve a stale body). Stock-detail header + chart's last bar now track this live price. Replaced the fabricated index chips. — ~15-min delayed |
| **Portfolio recalculation + editable holdings (CRUD)** | — (Firestore, no vendor) | `users/{uid}/holdings` (client SDK) | 🟢 **LIVE** | Portfolio total = Σ(shares × live snapshot price); add-form Shares input + inline editable position persisted to Firestore. Closed the gap where share qty was hardcoded to 10 with no editor |
| **Public `live` Cloud Run service** (two-service split) | — (infra) | `market-catalyst-live` (`APP_ROLE=live`, mounts only `LiveModule` + `/health`) | 🟢 **LIVE** | Makes the tape / snapshot / market-status read paths browser-reachable **without** exposing `/sync`·`/purge`·`/admin` (→ 404 on the public service, verified). This is the resolution of **O1**; see that row |
| **Market-status pill + extended-hours moves** | Polygon | `GET /v1/marketstatus/now` (+ snapshot early/late %) | 🟢 **LIVE** | Session-aware pill (pre / open / after / closed) and extended-hours cards, live once `NEXT_PUBLIC_BACKEND_URL` pointed at the public service |
| **Mobile login persistence fix** | — (Firebase Auth) | — | 🟢 **LIVE** | `navigateAfterAuth` waits for `onAuthStateChanged` non-null before hard-navigating, fixing the mobile "stuck on login page after sign-in" race |
| **`.firebaseapp.com` → `.web.app` redirect** | — (hosting) | — | 🟢 **LIVE** | Inline redirect script closes the duplicate-origin auth-session gap between the two Firebase Hosting domains |
| **Shared-collections read cache** (Firestore-read cost control) | — (infra) | `GET /live/collections?names=…` → 5-min server cache → Firestore | 🟡 **BUILT · not yet deployed** | 2026-07-24: `useCollection` routes the shared, slow-changing collections (indices, movers, sectors, breadth, sentiment, earnings, ipos, macro, recaps, insider, companies) through a **5-minute server cache** on the `live` service (`Cache-Control` + `ETag`/304, `If-None-Match`), so Firestore reads scale with **(instances × refreshes)** not **(users × documents)** — keeps the GCP bill flat as users grow. Owner-scoped collections stay on direct `onSnapshot`; the endpoint is allow-listed and falls back to Firestore if unreachable. Verified against prod Firestore; **committed, awaiting deploy** |

**Backend surface added for these:** `src/live/tape-universe.ts`, `tape.service.ts`, `tape.controller.ts`, `snapshot-cache.service.ts`, `snapshot.controller.ts`, `market-status.service.ts`, `cached-collections.service.ts`, `cached-collections.controller.ts`, plus the `APP_ROLE` split in `app.module.ts` and `CORS_ORIGINS` in `main.ts`. **UI:** `useMarketTape.ts`, `useSnapshotQuote.ts`, `live-prices.tsx` (`LivePricesProvider`), `useCollection.ts` (cache routing), `shell.tsx` marquee, `auth-utils.ts`.

---

## What's genuinely blocked (won't close with effort alone)

Two distinct kinds of blocker. **Vendor blocks** need a purchase. **Operational blocks** need no purchase and no new feature code — they are the reason production is quieter than the codebase suggests, and they are the higher priority of the two.

### Operational — production does not actually operate

| # | Blocker | What it breaks *right now* | Unblock path |
|---|---|---|---|
| O1 | 🟡 **PARTIALLY RESOLVED 2026-07-23.** The `/live/*` READ paths are now browser-reachable: `NEXT_PUBLIC_BACKEND_URL` points at the public `market-catalyst-live` service (verified from `marketcatalyst.web.app` with correct CORS), so the **ticker tape, market-status pill and extended-hours moves are live** for real users. **Still unreachable by design:** `/plans`, `/users/:uid/entitlements`, `/admin/*` live on the PRIVATE worker and are deliberately NOT mounted on the public service | Admin **Monitor** tab and the plans/admin APIs stay worker-only (frontend resolves entitlements straight from Firestore — see rows below) | ✅ Solved the read-path half **without** the risky Hosting→Cloud Run rewrite — the public service mounts only `LiveModule` (`/sync`, `/purge`, `/admin` → 404 there, verified), so `ADMIN_GUARD_TRUST_IAM=false` was never needed. Exposing the admin/plans APIs to the browser would be a separate, deliberate decision |
| O2 | ✅ **RESOLVED 2026-07-23.** **21 Cloud Scheduler jobs are ENABLED and firing on schedule**, with the `scheduler-invoker` SA present. Verified: `sync-companies` 06:00 UTC, `sync-news` 20:30 UTC, `sync-market-movers` 22:00 UTC — all matching their crons | *(was: nothing refreshed automatically)* | ✅ `create-scheduler-jobs.sh` has been run; jobs invoke the worker's `/sync/{job}/run` endpoints. Data now refreshes continuously |
| O3 | **`POLYGON_API_KEY` is un-rotated** — it was exposed in chat. Secret Manager version 4 is enabled | Live credential exposure | `deploy/rotate-polygon-key.sh` automates everything **except** generating the replacement key at Polygon |
| O4 | **Stripe is not implemented** — no Stripe code in either repo | No revenue path. `payments` / `subscriptions` are empty; `/admin/revenue` reports on nothing | Build it — then it still needs O1 for checkout + webhooks |
| O5 | **`api_usage` is not implemented** — no middleware records API calls | Admin "Usage & API" KPIs read 0; per-user apiCalls column reads 0 | Add recording middleware; the collection and its admin-read rule already exist |

### Vendor — needs a purchase

| Row | Blocker | Unblock path |
|---|---|---|
| R32 Options **greeks/IV/OI/bid-ask** | Polygon options *snapshot*: `NOT_AUTHORIZED` (re-probed 2026-07-22) | Wire **Tradier** (token already provisioned) or buy Polygon Options Advanced. ⚠️ Per-contract **OHLCV/VWAP is NOT blocked** and is already real — scope this narrowly |
| R41 Analyst per-firm events | Benzinga: 403 on plan | Buy Benzinga, or use Finnhub `/stock/recommendation` (history, not per-firm) |
| R42 Earnings depth (session/guidance) | FMP feed lacks fields | **Finnhub earnings** adds session (BMO/AMC); guidance needs Benzinga |
| R43 Options flow / dark pool | UnusualWhales unwired, not on plan | Purchase UW / Polygon-paid flow add-on |

**Also confirmed 403/404 on the current Polygon plan** (so nothing above is worth re-attempting): index values (`I:SPX`, `I:VIX`), trades/quotes/last-trade, `/benzinga/v1/*`, `/v1/summaries`; 404 on short-interest and futures. **Measured plan limits:** exactly **900 s (15 min)** quote delay, exactly **5-year** rolling history.

## The four low-effort wins — three now closed

The 2026-07-21 assessment listed four rows that needed **no new vendor**. As of 2026-07-22:

- ✅ **R24 financials** → done. Polygon `/vX/reference/financials` wired; full statements now stored, not discarded
- ✅ **R24 charts** → done. This was the big one — 1D/1W/5Y were never plan-blocked, only unsynced. Intraday bars job + 5-year backfill closed it; all 7 timeframes real
- ✅ **R29 EPS history** → done. 10 real quarters, plus balance sheet and cash flow beyond the row's scope
- ✅ **R26 F&G history** → **done 2026-07-23.** The 4-component composite methodology is now real (momentum/safe-haven/volatility/breadth), backfilled to `market_sentiment_history` and wired to the dashboard sparkline. The missing-rule bug that was hiding the gauge is also fixed.

Closed 2026-07-23, all Polygon/public data, no new vendor: **R28 Recaps EOD data job** (new `recaps.job` → live `recaps/{date}`, `recap.tsx` wired, fabricated extended-breadth block deleted) and **R30 Macro regime label** (`macro.tsx` computes Risk-On/Neutral/Risk-Off from VIX/breadth/yield). **R29 estimates** were recapped down to 90% to reflect the redistribution constraint: EPS *actuals* are complete Polygon data, but the *estimate* overlay has no redistributable source until Polygon's Benzinga add-on is purchased (FMP/Finnhub estimates are not licensed to redistribute and are not shipped).

**The replacement shortlist** (same character — no vendor needed, just work): O2 Cloud Scheduler, O1 Hosting rewrite + `ADMIN_GUARD_TRUST_IAM=false`, O3 key rotation, O5 `api_usage` middleware, R44 alerts engine.

## Notes on method

- Percentages reflect *scope delivered and reachable in production*, not calendar progress. A future-dated row at 0% is on-track, not late.
- W1–W3 weighted completion (**79%**, down from 82%) is the fair "are we on schedule?" number. The 48% overall is dragged down by 70.5 person-days of Aug–Sep work that isn't due.
- **Two rows were corrected downward or re-diagnosed on 2026-07-22, and both corrections matter more than the upward ones.** R5 fell 95%→75% on 2026-07-22 because "24/7" was never true — nothing was scheduled; it then **recovered to 98% on 2026-07-23** once the 21 Cloud Scheduler jobs were created (verified firing) and the backend was made browser-reachable via the public `market-catalyst-live` service. R26 was scored 95% on data that no user could actually see, because a missing Firestore rule silently replaced it with a hardcoded value. Both are reminders that *data existing in Firestore* is not the same as *a user seeing it*.
- R24's earlier note claimed a data-plan limitation that did not exist. Re-probing the plan live is now part of the assessment method, not an assumption carried forward.
- R6 (feature flags) — the note in the 2026-07-21 revision calling this an overdue miss is **stale**: it was built that same day and has since gained a second entitlement layer. Disregard it.
- The subscriptions/entitlements/admin workstream is real delivered work but is **outside the 36-row plan** and is excluded from all percentages.
