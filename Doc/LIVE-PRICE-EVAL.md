# Live price: our pipeline vs TradingView widget

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
> **This doc, specifically:** The evaluation is complete and the pipeline shipped (SSE tape + cached snapshot + shared subscription); the TradingView compare surface has been removed from the app.
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


> 🆕 **2026-07-22 — the conclusion at the bottom of this page was acted on.**
> The closing recommendation here ("polling the REST snapshot every 15–30 s is
> materially simpler and needs no warm instance — the data is equally stale
> either way") is now what the **header ticker tape** does, in
> `src/live/tape.service.ts`: one `/v3/snapshot?ticker.any_of=` call per 60 s
> for all 21 instruments, broadcast over SSE to every connected browser.
>
> The distinction against the per-ticker WebSocket documented below matters:
> that path opens **one upstream subscription per symbol a user is watching**
> and is capped at a single socket per API key, so it cannot scale past one
> instance. The tape path has no per-user or per-symbol upstream work at all —
> measured at 25 concurrent clients over ~3 minutes producing **3** vendor
> calls. The WebSocket demo below remains the right shape for a *single-symbol*
> deep view on a real-time plan; it is not what the tape uses.
>
> See `Doc/openapi.yaml` → `/live/tape/stream` and `deploy/DEPLOY.md` §3b.

An evaluation surface on the **Search** screen (`/menu/stock`) rendering both approaches side by side, so the choice can be made from observed behaviour rather than documentation.

## How to run it

```bash
# 1. backend (holds the Polygon key and the single upstream socket)
cd MarketCatalystBackEnd && npm run start:dev     # :4100

# 2. frontend
cd MarketCatalystUI && npm run dev                # :3000
```

Open **http://localhost:3000/menu/stock**. Both panels track whichever symbol is selected.

Requires the market to be open (09:30–16:00 ET) for ticks to flow. Outside those hours the left panel shows a "no tick for Ns" notice rather than pretending to be live.

## Architecture (side 1)

```
Polygon delayed WS ──► NestJS PolygonLiveService ──► SSE ──► React
  wss://delayed          one socket, ref-counted     /live/stream   useLiveQuote
  .polygon.io/stocks     per ticker                                 recomputes all
  channel A (per-sec)                                               derived values
```

**The browser never contacts Polygon.** The API key stays in the backend; the client opens an `EventSource` against our own origin. A key shipped to the browser is readable by anyone with devtools — there is no way to hide it there.

| File | Role |
|---|---|
| `src/live/polygon-live.service.ts` | Upstream WS, auth, ref-counted subscribe/unsubscribe, reconnect with capped backoff |
| `src/live/live.controller.ts` | `GET /live/stream?ticker=AAPL` → SSE (`snapshot`, `status`, `tick`) |
| `app/iq/hooks/useLiveQuote.ts` | EventSource client + all derived metrics |
| `app/iq/live-compare.tsx` | Both panels |

Derived on every tick: change, % change, session high/low, range position, session VWAP, premium/discount to VWAP, accumulated volume, tick count, tick rate, direction, **feed lag**, time since last tick.

## Verified plan entitlements (2026-07-20, live probes)

| Cluster / channel | Result |
|---|---|
| `wss://socket.polygon.io/stocks` (real-time) | ❌ `"You don't have access real-time data"` |
| `wss://delayed.polygon.io/stocks` — `A` (per-second aggs) | ✅ authorized, streaming |
| `wss://delayed.polygon.io/stocks` — `AM` (per-minute aggs) | ✅ authorized |
| `wss://delayed.polygon.io/stocks` — `T` (trades) | ❌ `"not authorized"` |
| `wss://delayed.polygon.io/stocks` — `Q` (quotes) | ❌ `"not authorized"` |

**Measured feed lag: ~903 s ≈ 15.05 min**, from a captured tick — `at` 1784557060000 vs `receivedAt` 1784557963191. That is the plan's delay, not network latency. The UI shows this figure live.

## What to compare

1. **Price gap.** Left is ~15 min behind; TradingView is at or near real-time. During a quiet tape the two look identical — during a fast move they diverge visibly. That divergence is the whole decision.
2. **Update cadence.** Left updates ~1×/sec while the market is open.
3. **Whether the data is *usable*.** The left panel's numbers are in your app's memory and can drive the screener, RS rating, alerts and Firestore writes. TradingView's numbers cannot be read by your code at all — the widget is a sealed iframe.
4. **Third-party dependency.** If the TradingView script is blocked (ad-blocker, CSP), its panel shows a load-failure notice. The left panel depends only on your own backend.

## Trade-offs

| | Our pipeline | TradingView widget |
|---|---|---|
| Latency | ~15 min delayed | real-time |
| Data reusable in your code | ✅ yes | ❌ no |
| Branding | yours | TradingView's |
| Effort to ship | backend + frontend (built) | drop in a script |
| Cost | current plan | free to embed |
| Infra | needs an always-on process | none |
| Licensing | your Polygon agreement | TradingView ToS; no redistribution |

## Blocker before this ships

**Cloud Run scale-to-zero cannot hold a WebSocket.** Production runs with no warm instance between Cloud Scheduler firings, and Cloud Run caps a connection at 60 minutes. As built this works locally; in production it needs `min-instances=1` plus reconnect-on-cap handling (backoff is already implemented).

If ~15-minute-delayed data is acceptable, **polling the REST snapshot every 15–30 s is materially simpler** and needs no warm instance — the data is equally stale either way. The WebSocket only earns its complexity alongside a real-time plan.

## Local `.env`

The backend needs `POLYGON_API_KEY` and `POLYGON_API_BASE_URL=https://api.massive.com`. `.env` is gitignored; it was populated from Secret Manager. `NEXT_PUBLIC_BACKEND_URL=http://localhost:4100` is set in the UI's `.env.local` — it holds no key, only a URL.
