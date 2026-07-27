# UI → Backend REST/SSE Migration (retire direct Firestore access from the browser)

> **Update 2026-07-27 — two environments + env-driven config.** This plan was
> written single-project (`market-catalyst-502415`). There are now **two isolated
> environments**: prod `market-catalyst-502415` and stage `market-catalyst-stage`
> (see `../02_Architecture_Document_Tracker.md`, top block). Everything below
> holds per-environment; the concrete changes are: (a) the backend Firestore/Auth
> project is chosen by `FIREBASE_PROJECT_ID` (stage = `market-catalyst-stage`),
> not pinned; (b) the UI's `NEXT_PUBLIC_BACKEND_URL` is no longer the mechanism —
> the base URL is resolved at runtime (`localhost:4100` in dev, same-origin when
> deployed, via `firebase.json` rewrites to `market-catalyst-live`), with
> `NEXT_PUBLIC_BACKEND_URL` kept only as an optional non-localhost override.

## Context

Today `MarketCatalystUI` talks to Firestore directly from the browser for
almost everything (~20 files, `onSnapshot`/`getDoc`/`setDoc` calls scattered
per screen, no shared types, no API client) — Firebase Auth is the only
backend-adjacent thing it uses. `MarketCatalystBackEnd` already has a mature,
mostly-unused surface built for exactly this: a vendor-swappable adapter layer,
a cache-aside on-demand layer, a poll-and-broadcast SSE layer, and 25 sync
jobs that populate Firestore. The goal of this change is architectural, not
cosmetic: move every Firestore read/write out of the browser and behind the
backend, so (a) the vendor (Polygon) can be swapped later with zero UI
changes, (b) Firestore reads scale with backend instances, not with user
count, and (c) per-user data (portfolio/watchlist/etc.) is properly
uid-scoped instead of trusting whatever the client sends.

**Documentation-drift finding, stated for the record:** `Doc/screen-data-sources.md`
in both repos currently describes an already-executed UI-side integration
(`app/iq/backend.ts`, "11 UI consumers rewired", a production DB reset) in
very confident past-tense language. This does not match the checked-out code:
`grep` for `fetch|axios|EventSource|NEXT_PUBLIC_BACKEND` across `app/` returns
zero hits, none of the named files (`backend.ts`, `useSnapshotQuote.ts`, etc.)
exist, and `git log` shows no commits implementing them. The **backend**-side
"on-demand" redesign described in the same doc *is* real (matches actual
commits `ea34f22`/`a77905c` and the code below). Treat the doc's UI-integration
claims as aspirational/stale for planning purposes — this plan starts from
"zero backend wiring exists in the UI," which is what the code shows.

**Confirmed with you during planning:**
- News: same cache-aside pattern as every other domain (first request hits
  Polygon/Finnhub via the existing adapter, subsequent requests served from
  the Firestore cache). TTL/refresh cadence is a detail to tune later, not a
  blocker now.
- Scope includes Settings, Profile, Notifications, and ticker search — full
  migration, nothing left calling Firestore directly except Firebase Auth
  itself when this is done.
- The UI gets a shared `types/` module and one API-client/hook layer as part
  of this work, replacing the current per-screen duplicated interfaces.

## Prerequisite — you said you'd provide this

**Backend needs real Firebase credentials to do anything with Firestore —
via an environment variable, not a checked-in key file.**
`firebase-admin.provider.ts` currently only knows how to load a
service-account key from a **file path**
(`FIREBASE_SERVICE_ACCOUNT_PATH=./service-account.json`, which doesn't exist
locally — `ls` confirms), falling back to Application Default Credentials.
Per your instruction, this plan does **not** check in a key file. As part of
Phase 0, `FirebaseAdminService.onModuleInit()` (`firebase-admin.provider.ts:23-54`)
gets a small change: read the service-account JSON from a new env var (e.g.
`FIREBASE_SERVICE_ACCOUNT_JSON`, the key file's contents as a JSON string —
or base64-encoded if the hosting env mangles raw JSON in an env var) and
`JSON.parse()`/`cert()` it, checked **before** the file-path and ADC fallbacks.
Locally this goes in `.env` (already gitignored); in any deployed environment
it's a Secret Manager-backed env var, never a file baked into the image —
consistent with how every other credential in `.env.example` already works.
**Please provide the service-account JSON's contents** (a service account
with Firestore + Firebase Auth admin access to `market-catalyst-502415`) so it
can be set as that env var locally. Separately, `POLYGON_API_KEY` (and ideally
`FMP_API_KEY`/`FINNHUB_API_KEY` for fallback paths) are blank in the local
`.env` — needed to exercise any adapter-backed endpoint end-to-end locally.

## Architecture decisions

1. **Reuse the adapter/job/cache layer as-is.** `src/adapters/*` (vendor
   swap via `*_SOURCE`/`*_FALLBACK_SOURCE` env vars, `Composite*Adapter` +
   `withFallback()`), the 25 `src/sync/*.job.ts` jobs, `SyncRegistry`,
   `SyncMetaService`, and `CachedCollectionsService` are untouched. This is
   exactly the adapter-layer-in-front-of-Polygon the task asks for and it
   already exists — no need to rebuild it.

2. **New "screen-facing" read module, not a rewrite of `LiveModule`.** Add
   `src/market-data/` with one thin controller per domain. Each one calls
   `CachedCollectionsService.get([...])` (already does the 5-minute
   allow-listed cache-aside — see `cached-collections.service.ts:23-79`) and
   **reshapes** the raw Firestore docs into the UI's existing local
   interfaces (`LiveMoverDoc`, `SectorApiDoc`, `AnalystConsensusDoc`, etc. —
   catalogued in the frontend research, now promoted into the UI's new shared
   `types/` module). This is the "response tuned to the UI" + "naming as per
   frontend functionality" requirement: field names match what the UI already
   expects, so screens change their data source, not their rendering code.
   `CachedCollectionsService`'s `ALLOWED` set (line 23) needs `news`,
   `dividends`, `financials`, `dividend_history`, `splits` added — a one-line
   change each, same pattern as the existing 15 entries.

3. **Per-ticker single-doc domains stay on the existing on-demand cache-aside
   pattern**, not the bulk collection cache. `options-chains`,
   `dividend-history`, `splits`, `financials`, per-ticker `news` all follow
   the same shape as `OnDemandController`/`OnDemandService`
   (`ondemand.controller.ts:41-71`, `ondemand.service.ts:594-603`'s `isFresh()`
   TTL idiom): check the Firestore doc's `createdAt`/TTL → if fresh, serve →
   if stale/missing, call the adapter → write back → serve. This is the exact
   cache-aside sequence in your diagram, applied per-ticker instead of
   per-collection.

3a. **No cron jobs run in this version — everything is lazily triggered by
   the incoming request, nothing by a schedule.** You asked to suppress all
   cron jobs for now and add cache-warm-up crons back in later, selectively.
   Concretely:
   - The two **real** in-process `@Cron` jobs — `RetentionService.scheduled()`
     (`retention.service.ts:38`, weekly) and `AutoPurgeJob.scheduled()`
     (`auto-purge.job.ts:57`, nightly) — get gated behind a new config flag,
     e.g. `ENABLE_SCHEDULED_JOBS` (default `false`). When false, the `@Cron`
     handler body no-ops (logs and returns) instead of running; the routes
     that trigger them on demand (if any) are unaffected. Add the same guard
     to `ScheduleModule.forRoot()`'s registration in `app.module.ts` only if
     needed to stop the timers firing at all, otherwise the no-op guard alone
     is enough.
   - The 25 `src/sync/*.job.ts` jobs are already **not** self-scheduling in
     process (see research: none use `@Cron`; they register a
     `cronExpression` in `SyncRegistry` purely as metadata for
     `GET /sync/jobs`'s `nextRunAt` display and for an external Cloud
     Scheduler to call `POST /sync/:job/run`). For this version: **do not
     create any Cloud Scheduler jobs**, locally or in any deployed
     environment touched by this work. Nothing needs disabling here — the
     jobs are already inert unless something calls their HTTP trigger.
   - Because no cron/scheduler will pre-populate the bulk collections
     (`market_movers`, `sectors`, `earnings_events`, `analyst_actions`,
     `ipos`, `macro_events`, `dividends`, etc.), the new `src/market-data/`
     controllers from decision #2 must not assume that data. Each one checks
     `SyncMetaService.status(jobName)`/the collection's own freshness and, on
     a miss or stale read, calls `SyncRegistry.get(jobName)()` **synchronously
     as part of serving the request** (the same call `POST /sync/:job/run`
     already makes — see `sync.controller.ts`) before responding. This turns
     every bulk domain into the same request-triggered cache-aside flow as
     `OnDemandController` already has for company/bars, and is what makes the
     "first user hits origin, next user gets it from the database" behavior
     work with zero crons at all. `SyncRegistry`'s `isRunning` flag already
     gives free single-flight protection against concurrent requests
     stampeding the same refresh.
   - This is deliberately a "make it correct with zero scheduling" milestone.
     Re-introducing warm-up crons later (so a user's first request doesn't
     pay the vendor-call latency) is explicitly out of scope for this plan —
     flagged as a follow-up to pick up selectively, domain by domain, once
     this on-demand behavior is verified end-to-end.

4. **News gets the same treatment**, per your answer: a new endpoint that
   checks `news/{ticker or query key}` freshness, calls the existing
   Polygon-primary news adapter on a miss/stale, writes back, serves — reusing
   `news.job.ts`'s adapter call, not a hand-rolled fixture. A generous default
   TTL now (e.g. 15 min, matching the existing job's 30-min cadence), tunable
   later — flagged as a follow-up, not re-litigated in this plan.

5. **Auth: build the one guard that's missing.** `AdminGuard`
   (`src/common/admin.guard.ts:38-96`) is admin-only by design (single fixed
   email) — it is the model to follow, not extend. Add a sibling
   `FirebaseAuthGuard` (`src/common/firebase-auth.guard.ts`) that verifies any
   Firebase ID token via `this.firebase.auth.verifyIdToken()` and attaches
   `req.uid = decoded.uid` (no email allow-list check). A `@CurrentUser()`
   param decorator reads `req.uid`. Every per-user endpoint uses the guard's
   `uid`, **never** a client-supplied uid in the URL/body — this is what makes
   per-user partitioning actually safe.

6. **Per-user endpoints reuse the existing Firestore layout exactly** —
   `users/{uid}/watchlists/default`, `users/{uid}/portfolios/default(+holdings
   subcollection)`, `users/{uid}/notifications/{id}`, `settings/{uid}`,
   `users/{uid}` (profile), `stock_comments` (chart notes) — all already
   documented and partially exercised by `notifications.service.ts:40-73`.
   New `src/user-data/` module: `WatchlistController`, `PortfolioController`,
   `SettingsController`, `ProfileController`, `NotificationsController`,
   `StockNotesController`, all behind `FirebaseAuthGuard`, all using
   `batchSetWithCreatedAt`/`setWithCreatedAt` (`firestore-batch.util.ts`) for
   writes like every other Firestore writer in the codebase.

7. **Real-time per-ticker price: one true WebSocket server between the
   browser and the backend, per your sequence diagram — an MRU-registry
   extension of the single-Polygon-connection pattern that already exists,**
   not the poll-based approach this plan originally proposed. Concretely:
   - `PolygonLiveService` (`polygon-live.service.ts`) already IS the
     "single persistent connection to Polygon" + "ref-counted
     subscribe/unsubscribe" + "per-ticker fan-out" half of your diagram
     (steps 3-10, 14-18) — its `subscribe(ticker)`/`unsubscribe(ticker)`
     ref-counting and per-ticker `Subject` are reused essentially as-is as
     the **MRU Ticker Registry** + upstream leg. It gets one addition: an
     explicit **in-memory live-tick cache** (`Map<ticker, LiveTick>`,
     updated on every incoming Polygon message) so a *new* subscriber gets
     the last known value immediately instead of waiting for the next tick —
     this is the "read from persistent in-memory cache" half of your
     original ask. Ref-count-to-zero still triggers the upstream
     `unsubscribe` immediately (diagram steps 19-24); the cached last value
     for that ticker is kept for a short grace period (a few minutes) rather
     than wiped instantly, so a client that quickly re-subscribes (e.g.
     navigating away from Stock Detail and back) gets an instant value
     instead of a blank state — this is the "MRU… frequently requested
     tickers remain active" note in your diagram, implemented as a
     retention grace period on the cache rather than a hard subscriber cap
     (no cap was specified; add one later if Polygon's concurrent-symbol
     limit needs it).
   - What's new: a **browser-facing WebSocket gateway**
     (`src/live/live-ws.gateway.ts`), replacing the current one-ticker-per-
     SSE-connection shape of `LiveController.stream()` with a real
     bidirectional socket where one client connection sends
     `{action:"subscribe"|"unsubscribe", ticker}` messages for as many
     tickers as that browser tab needs over time (diagram steps 1, 8, 11,
     19) and receives pushed tick/snapshot messages for whichever it's
     subscribed to (steps 12-13). `ws` is already a project dependency
     (used today only for the outbound Polygon leg), so the inbound server
     side reuses it too rather than adding `@nestjs/websockets`/socket.io.
   - **One WS connection per browser tab, shared across every screen that
     needs a live price** — watchlist, portfolio holdings, movers, heatmap,
     screener rows, stock detail, search — each screen subscribes/
     unsubscribes its own tickers as it mounts/unmounts, multiplexed over
     the one socket, matching "we will have only one websocket from backend
     to origin" (upstream) and giving the UI one shared connection
     (downstream) instead of the old per-screen Firestore `onSnapshot`
     sprawl. This replaces the "poll `GET /live/snapshot`" idea from the
     initial pass of this plan for anything needing live push; `/live/snapshot`
     itself is untouched and stays available as the existing REST fallback
     it already is.
   - **Ticker tape (shell strip, Dashboard Market Pulse)** is a fixed,
     always-on set (~9 index/macro tiles + configured tape stocks), not a
     per-client dynamic interest set — the UI auto-subscribes to that fixed
     set over the same WS channel on connect, unifying tape + per-ticker
     overlays into one real-time mechanism rather than two. `TapeService`/
     `TapeController`'s existing SSE endpoints (`/live/tape`, `/live/tape/stream`)
     are left in place, unused by the migrated UI but available as the
     documented CDN-cacheable polling fallback if the WS channel ever needs
     a cheaper degrade path — not needed for this plan.

8. **UI gets one API-client + one shared types module.**
   `app/iq/backend.ts` (new) — a thin `fetch` wrapper: reads
   `NEXT_PUBLIC_BACKEND_URL`, attaches `Authorization: Bearer <idToken>` when
   `firebaseAuth.currentUser` exists (via `getIdToken()`), throws on non-2xx.
   `app/iq/types/` (new) — one file per domain, each interface promoted
   verbatim from wherever it's most complete today (e.g. `insider.tsx`'s
   richer `CompanyDoc`), so screens importing it get a superset of what they
   had. A small `useApiResource(path)` hook (fetch + refetch-on-interval,
   replacing `useCollection`) and reuse of the EventSource pattern for the two
   SSE consumers.

## Phased plan (each phase ends in something checkable in the running UI)

**Phase 0 — Foundations.** Backend: `FirebaseAuthGuard` + one throwaway
protected route (`GET /api/whoami-user` → `{uid}`) to prove the token round
-trips; add `ENABLE_SCHEDULED_JOBS` (default `false`) and gate
`RetentionService.scheduled()`/`AutoPurgeJob.scheduled()` behind it (decision
#3a). UI: `app/iq/backend.ts`, `app/iq/types/` skeleton,
`NEXT_PUBLIC_BACKEND_URL` env var. *Verify:* logged-in browser console hits
the protected route via the new client and gets back the correct uid;
logged-out gets 401; backend startup log shows no scheduled-job cron firing.

**Phase 1 — Shell ticker strip + market-status pill.** Rewire
`app/iq/shell.tsx` + `app/iq/live-market-indices.ts` to `GET /live/tape/stream`
(SSE) instead of the `market_indices` `onSnapshot`; wire
`app/iq/market-status.ts` to `GET /live/market-status`. *Verify:* the ticker
strip on every screen still shows correct live values; DevTools network tab
shows an EventSource to the backend, zero Firestore listener for
`market_indices`.

**Phase 2 — Market-wide read screens.** Backend: `src/market-data/` module,
domain-by-domain (`market-movers`, `sectors`, `companies` bulk,
`earnings-events`, `analyst-actions`, `insider-transactions`, `ipos`,
`macro-events`, `dividends`), each shaping `CachedCollectionsService` output
into the promoted UI types, each triggering its job on-demand when stale/empty
per decision #3a (no cron has populated these — the first request for a
domain pays the vendor-call latency, subsequent requests are served from
Firestore/cache). UI: replace `useCollection()` in Movers, Heatmap,
Analyst, Screener, Themes, Earnings Hub, Insider (transaction feed only),
IPOs, Macro (indicators + calendar cards) with `useApiResource()` calls; drop
their local Firestore imports. Sub-phase however you want to verify
incrementally (e.g. 2a Movers+Heatmap, 2b Analyst+Screener+Themes, 2c
Earnings+IPOs+Macro+Insider). *Verify per sub-phase:* each screen renders the
same values as before, no Firestore reads for that screen's collections in
DevTools.

**Phase 3 — Dashboard.** Swap its 8 `useCollection`/inline-`onSnapshot` calls
for the Phase 2 endpoints + Phase 1's tape; Portfolio Pulse/Watchlist
mini-widgets and Live Market Feed stay on Firestore until Phases 4/5. *Verify:*
Dashboard matches pre-migration values for every widget except portfolio/
watchlist-mini/news.

**Phase 4 — Stock Detail.** Reuse `GET /live/bars`/`GET /live/company`
as-is (already cache-aside, already built) for price/chart/profile/peers; new
per-ticker endpoints for `dividend-history`, `splits`, `financials`
(cache-aside pattern from decision #3); new `StockNotesController`
(auth-guarded, replaces direct `stock_comments` `addDoc`/`getDocs`/`deleteDoc`
in `stock.tsx`); news panel wired to the Phase-6 news endpoint if that phase
is done first, otherwise deferred. *Verify:* all 7 chart timeframes render,
dividend/split history renders, notes CRUD works logged-in, zero Firestore
calls from this screen.

**Phase 5 — Portfolio & Watchlist.** `src/user-data/` `WatchlistController` +
`PortfolioController` behind `FirebaseAuthGuard`, backed by the existing
`users/{uid}/watchlists/default` and `users/{uid}/portfolios/default(+holdings)`
paths. UI: `watchlist.tsx`, `portfolio.tsx`, and Dashboard's two mini-widgets
move off direct `doc/onSnapshot/setDoc/deleteDoc`. *Verify:* add/remove a
holding and a watchlist ticker as a logged-in test user, reload, confirm
persistence via the backend (Network tab shows the new REST calls, no
Firestore SDK writes).

**Phase 6 — News.** New cache-aside news endpoint per decision #4, add `news`
to the `CachedCollectionsService` allow-list or give it its own per-query TTL
cache (whichever the actual access pattern — global feed vs. per-ticker —
turns out to need; decide at implementation time). UI: `commentary.tsx`,
Dashboard's `LiveFeedList`, Stock Detail's news panel move off their three
independent `useCollection("news")` calls onto the one endpoint. *Verify:*
news content renders in all three places from the backend.

**Phase 7 — Settings, Profile, Notifications, Search.**
`SettingsController`, `ProfileController`, `NotificationsController` (all
`src/user-data/`, auth-guarded); ticker search UI (`useTickerSearch.ts`)
switches to the already-built `GET /live/search` (in-memory, zero Firestore
reads) instead of its three parallel Firestore prefix queries. *Verify:* theme
toggle and font persist across reload via backend; profile edit persists;
notification bell lists/marks-read via backend; Cmd+K search still finds
tickers.

**Phase 8 — Options & Insider drill-down & Recap.** Per-ticker
`options-chains` cache-aside endpoint (curated 8-ticker universe, same
pattern as #3); `InsiderPositionsController` (thin on-demand wrapper over
`fund_holdings/{cik}/filings/{accession}/positions`, no caching needed — it's
a rare per-click read); `recaps` already allow-listed in
`CachedCollectionsService`, just needs a controller. *Verify:* Options
screen's live card, Insider's CUSIP-matched drill-down, and Recap's static
content all work with zero Firestore calls.

**Phase 9 — Cleanup.** Remove `firebase/firestore` import and `getFirestore()`
call from `app/firebase.ts` (keep `firebase/auth` only) — this is the forcing
function that proves nothing was missed; a leftover Firestore call becomes a
build/runtime error, not a silent bypass. Sweep `app/` for any remaining
`onSnapshot`/`getDoc`/`setDoc`/`addDoc` (should be zero outside `firebase.ts`
itself). Full click-through smoke test of every screen with DevTools Firestore
listener count at zero.

## Verification approach

After each phase: run the backend (`npm run start:dev`, port from `.env`) and
the UI (`npm run dev --prefix ../MarketCatalystUI`) together, exercise the
affected screen(s) in a real browser, and confirm in DevTools Network/on the
Firestore usage dashboard that the migrated screen no longer opens a listener
for its old collection(s). For auth-guarded endpoints, test both a logged-in
and a logged-out request (expect 200 vs 401). Where a screen has a
demo/mock-data fallback (watchlist/portfolio when signed out), confirm that
fallback still renders — the backend migration must not regress the existing
"demo data until real data exists" UX.
