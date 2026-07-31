# Market Intelligence Platform — Firestore Security Rules

> ## ⏱ State sync — 2026-07-27 · TWO ENVIRONMENTS (stage + prod), env-driven config
>
> _This block is newest and authoritative where it differs from the blocks
> below. It introduces a second, fully-isolated environment; nothing about the
> per-environment runtime topology (§6, the on-demand data layer, the CDN
> rewrite) changes — that topology now simply exists twice, once per project._
>
> **This doc, specifically:** The same `firestore.rules` + `firestore.indexes.json`
> now deploy to two independent Firestore instances (prod + stage) instead of
> one; rule content itself is unchanged, only the deploy-target count.
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
> **This doc, specifically:** For rules: read rules were added for `recaps` and `market_sentiment_history`; the new `/live/collections` endpoint reads shared collections server-side (owner-scoped paths stay client-direct).
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


v1.2 | July 2026

> **⚠⚠ THE DEPLOYABLE RULES FILE IS NOT IN THIS REPO (added 2026-07-22).**
> Both repos ship a `firestore.rules`, and the two files have **drifted**.
> The LIVE ruleset is deployed from
> **`MarketCatalystUI/firestore.rules`** — that is the source of truth for
> everything in this document. The copy at
> `MarketCatalystBackEnd/firestore.rules` is stale and now carries a
> `DO NOT DEPLOY` header; **deploying it would remove read access to
> `financials` and `market_breadth`**, breaking Stock Detail and the
> Dashboard internals. The drift runs in **both** directions, so neither
> file is a superset — see §12 before touching either one.

> **⚠ Implementation status (updated 2026-07-22; earlier notes 2026-07-09, 2026-07-05):**
> Subscriptions have since landed **partially**: a `plans` collection,
> plan entitlements and an admin console now exist (see §9–§11), but
> **Stripe is still not implemented** — no Stripe code exists in either
> repo, and `payments` / `subscriptions` are empty collections. Nothing
> sets the `tier` custom claim yet, so the Free/Pro/Premium gating below
> remains inactive.
> The tier-gating design below (Stripe custom claims, Free/Pro/Premium
> collection-level blocks, Fastify API middleware field-stripping, ECS
> workers) was never implemented — no subscription/billing system exists
> yet. The real `firestore.rules` (same folder) relaxes every originally
> tier-gated collection to `allow read: if isAuthenticated()`, with an
> explicit `// TODO(tier-gating)` comment marking where to restore this
> design once Stripe/subscriptions actually exist. All market-data writes
> are still server-only via the NestJS backend's Admin SDK
> (`backend/src/common/firebase-admin.provider.ts`), matching Principle 2
> below — that part is accurate. §3 (`stock_comments`) is accurate and
> implemented as described. The collection list is also incomplete — see
> the real `firestore.rules` for `tickers`, `market_movers_history`,
> `sectors_history`, and `market_indices_history`, none of which existed
> when this doc was written. `portfolios/{id}` also now carries a
> materialized `totalValue`/`dayPL`/`dayPLPct`/`holdingsCount`/`updatedAt`
> summary (2026-07-08), written client-side under the same existing
> `allow update: if isOwner(uid)` rule — no rule change was needed for it.
> A composite Firestore index (`firestore.indexes.json`, new as of
> 2026-07-08 — none existed before) is now deployed for `ohlcv_bars`
> (`ticker` + `barDate`), required by both the RS Rating job and the Stock
> Detail chart's live-history hook; deploy with
> `firebase deploy --only firestore:indexes`.

The deployable rules file is `firestore.rules` in the **MarketCatalystUI**
repo root. Deploy from there with:

```bash
# run from MarketCatalystUI/, NOT from the backend repo
firebase deploy --only firestore:rules
```

---

## 1. Core Design Principles

**Principle 1 — Tier via custom claims, not Firestore reads.**
Subscription tier (`free` / `pro` / `premium`) is stored as a Firebase Auth custom claim on the user's ID token, not read from Firestore during rule evaluation. This means zero extra Firestore reads per request and instant evaluation.

The backend sets the claim whenever a Stripe webhook fires (subscription created, updated, or cancelled):

```js
// Node.js — called from Stripe webhook handler in Fastify
await admin.auth().setCustomUserClaims(uid, { tier: 'pro' });
```

The client must refresh its token after an upgrade for the new claim to take effect:
```js
// React — force token refresh after Stripe checkout success
await firebase.auth().currentUser.getIdToken(/* forceRefresh */ true);
```

**Principle 2 — All market data is server-write-only.**
Every market data collection (`news`, `earnings_events`, `analyst_actions`, etc.) has `allow write: if false`. ECS workers use Firebase Admin SDK, which bypasses security rules entirely — so workers write freely. Clients can never write to these collections, even if they craft a direct Firestore SDK call.

**Principle 3 — User data is uid-scoped.**
All user sub-collections (`portfolios`, `watchlists`, `alerts`, `notifications`) are readable and writable only by the owning user. No user can read another user's data.

**Principle 4 — User-generated content (stock_comments) is user-scoped.**
The `stock_comments` collection stores user notes attached to stock charts. Each document has a `uid` field. Users can only read/write/delete their own notes. Other users cannot read another user's notes.

**Principle 5 — Field-level gating stays at the API layer.**
Firestore rules are all-or-nothing per document. They cannot strip individual fields before returning a document. Tier-gated fields (e.g. `aiNote` on analyst actions for Pro+ only) are stripped by the Fastify API middleware before the response reaches the client. Direct Firestore SDK reads from the client are not supported for field-level gates.

**Principle 6 — Admin identity is proved by the token, not by a Firestore lookup.**
`isAdmin()` accepts either an `admin: true` custom claim or the one fixed
admin email, and reads both off the ID token — same rationale as Principle 1.
The same address is checked by the backend's `AdminGuard`, so the rules and
the admin API agree about who is an admin. Full detail in §9.

**Principle 7 — Money is server-write-only; analytics has exactly one exception.**
`payments` and `subscriptions` are `allow write: if false` outright, and
`plans` accepts only a narrow entitlements-shaped update from the admin (§10).
`feature_adoption` is the **single** client-writable analytics collection, and
that is a deliberate, bounded trade-off rather than an oversight — §11 states
what is given up and why it is acceptable there and nowhere else.

---

## 2. Collection Access Matrix

This matrix lists **every** `match` block in the live ruleset
(`MarketCatalystUI/firestore.rules`) as of 2026-07-22. The **Live read** and
**Live write** columns are what production actually enforces today; the
**Designed tier gate** column records the tier restriction this document
originally specified, which is *not* in force because nothing sets the `tier`
claim yet. Each of those rows carries a `// TODO(tier-gating)` comment in the
rules file marking where to restore it.

Anything **not** in this table is refused by the `match /{document=**}`
catch-all at the bottom of the file — silently, as a `permission-denied` on
read. See §13 for two collections that were missing from this table and from
the rules, and what that broke.

### 2.1 Market & reference data — server-write-only

| Collection | Live read | Live write | Designed tier gate (inactive) |
|---|---|---|---|
| `companies` | ✅ Authenticated | ❌ Server only | — |
| `tickers` | ✅ Authenticated | ❌ Server only | — |
| `feature_flags` | ✅ Authenticated | ❌ Server only | — |
| `ohlcv_bars` | ✅ Authenticated | ❌ Server only | — |
| `intraday_bars` | ✅ Authenticated | ❌ Server only | — |
| `dividend_history` | ✅ Authenticated | ❌ Server only | — |
| `splits` | ✅ Authenticated | ❌ Server only | — |
| `financials` | ✅ Authenticated | ❌ Server only | — |
| `earnings_events` | ✅ Authenticated | ❌ Server only | — |
| `earnings_summaries` | ✅ Authenticated | ❌ Server only | Pro+ |
| `news` | ✅ Authenticated | ❌ Server only | — |
| `analyst_actions` | ✅ Authenticated | ❌ Server only | `aiNote` field, Pro+ |
| `macro_events` | ✅ Authenticated | ❌ Server only | — |
| `market_movers` | ✅ Authenticated | ❌ Server only | — |
| `market_movers_history` | ✅ Authenticated | ❌ Server only | — |
| `market_indices` | ✅ Authenticated | ❌ Server only | — |
| `market_indices_history` | ✅ Authenticated | ❌ Server only | — |
| `market_breadth` | ✅ Authenticated | ❌ Server only | — |
| `market_sentiment` | ✅ Authenticated | ❌ Server only | — |
| `sectors` | ✅ Authenticated | ❌ Server only | — |
| `sectors_history` | ✅ Authenticated | ❌ Server only | — |
| `ipos` | ✅ Authenticated | ❌ Server only | — |
| `dividends` | ✅ Authenticated | ❌ Server only | — |
| `insider_transactions` | ✅ Authenticated | ❌ Server only | — |
| `options_chains` | ✅ Authenticated | ❌ Server only | — |
| `options_flow` | ✅ Authenticated | ❌ Server only | Pro+ |
| `block_trades` | ✅ Authenticated | ❌ Server only | Pro+ |
| `fund_holdings/{cik}` | ✅ Authenticated | ❌ Server only | Pro+ |
| `fund_holdings/{cik}/filings` | ✅ Authenticated | ❌ Server only | Pro+ |
| `fund_holdings/{cik}/filings/{id}/positions` | ✅ Authenticated | ❌ Server only | Pro+ |
| `story_stocks` | ✅ Authenticated | ❌ Server only | Premium |
| `recaps` | ✅ Authenticated | ❌ Server only | Pro+ |

Notes on the newer entries:

- `intraday_bars` — one doc per `(ticker, resolution)` holding an **array** of
  bars, not a doc per bar. Feeds the 1D/1W/1M chart timeframes, which rendered
  a synthetic random walk before this collection existed.
- `dividend_history` — full declared payment history, annual totals, CAGR and
  increase streak per ticker.
- `splits` — declared here with **no UI consumer yet**, precisely so the read
  is already allowed when one lands; otherwise the catch-all would fail it
  silently.
- `feature_flags` — the `FF_*` release flags ("is it built?"). These are a
  **separate** gate from plan entitlements ("may this tier use it?") — see §10.

### 2.2 Billing & entitlements

| Collection | Live read | Live write |
|---|---|---|
| `plans/{planId}` | ✅ Authenticated (upgrade screen renders it) | Admin `update` of `featureFlags` + `updatedAt` **only**; create/delete ❌ |
| `payments/{paymentId}` | Admin, **or** owner via `resource.data.userId` | ❌ Server only |
| `subscriptions/{subId}` | Admin, **or** owner via `resource.data.userId` | ❌ Server only |

Detail and rationale in §10. `payments` and `subscriptions` are currently
**empty** — Stripe is not implemented.

### 2.3 Analytics

| Collection | Live read | Live write |
|---|---|---|
| `api_usage` | Admin only | ❌ Server only |
| `audit_logs` | Admin only | ❌ Server only |
| `revenue_summary` | Admin only | ❌ Server only |
| `system_metrics` | Admin only | ❌ Server only |
| `feature_adoption` | Admin, **or** owner via `resource.data.userId` | ⚠ **Client** create/update, constrained; delete ❌ |

Read is admin-only across this group because per-user API call logs and
feature usage are behavioural data about identifiable people, not market data.
`feature_adoption` is the one write exception — §11.

Of these, only `feature_adoption` currently holds data (~12 seeded rows);
`api_usage`, `audit_logs`, `revenue_summary` and `system_metrics` are empty.
`api_usage` in particular is specified but **not implemented** — no middleware
records API calls, so the admin console's usage KPIs read 0.

### 2.4 User-owned data

| Collection | Live read | Live write |
|---|---|---|
| `stock_comments` | Owner (`resource.data.uid`) | Owner create (validated); update ❌ immutable; owner delete |
| `users/{uid}` | Owner **or admin** | Owner create (`tier == 'free'`) / owner update via `noTierOrUidChange()`; delete ❌ |
| `users/{uid}/portfolios` | Owner | Owner |
| `users/{uid}/portfolios/{id}/holdings` | Owner | Owner |
| `users/{uid}/watchlists` | Owner | Owner |
| `users/{uid}/alerts` | Owner | Owner (12 validated `type` values) |
| `users/{uid}/notifications` | Owner | Owner may flip `read → true` or delete; create ❌ server only |
| `settings/{uid}` | Owner | Owner |

`users/{uid}` gained **admin read** so the console can populate its Users /
Subscriptions / Revenue screens. It is read-only for the admin by design: the
console never mutates a subscription from the client, because a tier change
must go through the backend so it is audited and so `featureFlags` stays
consistent with the plan.

---

## 3. stock_comments Collection

The `stock_comments` collection stores user notes on stock charts, written from the Stock Detail page (`screens/stock.tsx`) using the Firebase client SDK.

> **Fixed 2026-07-22.** The rule below is correct and is what the live ruleset
> now enforces — but until this date the live ruleset had **no `match` block
> for `stock_comments` at all**, so the catch-all denied every read and write
> and the notes feature failed silently. See §13.

### Schema
```
Collection: stock_comments
Document ID: auto-generated

{
  uid:       string,     // Firebase Auth user ID
  sym:       string,     // stock ticker (e.g. "NVDA")
  name:      string,     // company name (e.g. "NVIDIA Corp.")
  comment:   string,     // note text entered by user
  createdAt: Timestamp   // Firestore server timestamp
}
```

### Rule design
```js
// stock_comments: users can only read/write/delete their own notes
match /stock_comments/{docId} {
  allow read, delete: if request.auth != null
                     && resource.data.uid == request.auth.uid;

  allow create: if request.auth != null
               && request.resource.data.uid == request.auth.uid
               && request.resource.data.comment is string
               && request.resource.data.comment.size() <= 2000
               && request.resource.data.sym is string;

  allow update: if false;  // notes are immutable — delete and re-create to edit
}
```

### Firestore queries used
```ts
// Load notes for current user + ticker
const q = query(
  collection(db, 'stock_comments'),
  where('uid', '==', currentUser.uid),
  where('sym', '==', sym),
  orderBy('createdAt', 'asc')
);

// Save a note
await addDoc(collection(db, 'stock_comments'), {
  uid: currentUser.uid,
  sym,
  name,
  comment,
  createdAt: Timestamp.now(),
});

// Delete a note
await deleteDoc(doc(db, 'stock_comments', noteId));
```

### Composite index required
```json
{
  "collectionGroup": "stock_comments",
  "fields": [
    { "fieldPath": "uid",  "order": "ASCENDING" },
    { "fieldPath": "sym",  "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "ASCENDING" }
  ]
}
```

---

## 4. Subscription Tier Gating Details

### What's gated at the rules level (collection-level block)

> **Design only — not in force.** Nothing sets the `tier` custom claim yet, so
> every collection below currently reads as `allow read: if isAuthenticated()`
> with a `// TODO(tier-gating)` marker. See the **Designed tier gate** column
> in §2.1 for the live position.

These collections are *intended* to return a `permission-denied` error to clients without the right tier:

- `earnings_summaries` — requires Pro+
- `options_flow` — requires Pro+
- `block_trades` — requires Pro+
- `fund_holdings` (+ sub-collections) — requires Pro+
- `recaps` — requires Pro+
- `story_stocks` — requires Premium only

### What's gated at the API middleware level (field stripping)

These collections are readable by all tiers but the API strips restricted fields before returning the response:

| Collection | Restricted Field | Required Tier |
|---|---|---|
| `analyst_actions` | `aiNote` | Pro+ |
| `news` | `body` (full text) | Pro+ (basic summary free) |
| `earnings_events` | `transcriptUrl` | Pro+ |

The client always calls the REST API (`/api/v1/...`), not Firestore directly, for these endpoints. Direct Firestore SDK reads are only used for user-owned data.

### What's gated at the API middleware level (watchlist count)

- Free tier: max 5 tickers per watchlist. Firestore rules cannot count sub-collection documents, so this is enforced in the `POST /api/v1/watchlists/:id/tickers` handler.

---

## 5. Notifications: Write Rules

Notifications are created exclusively by the alert engine (server, Admin SDK). Clients can:
- **Read** their notifications
- **Mark as read** (update `read` field to `true` only — no other field changes allowed)
- **Delete** a notification (dismiss)

They cannot create notifications directly. The rule enforces this precisely:

```js
allow update: if isOwner(uid)
              && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['read'])
              && request.resource.data.read == true;
```

---

## 6. User Document: Tier Protection

The `users/{uid}` document holds the `tier` field, which must only be updated by the server (Stripe webhook → Admin SDK). The `noTierOrUidChange()` helper blocks any client update that tries to modify `tier`, `uid`, `stripeCustomerId`, or `stripeSubId`:

```js
function noTierOrUidChange() {
  return !request.resource.data.diff(resource.data).affectedKeys()
           .hasAny(['uid', 'tier', 'stripeCustomerId', 'stripeSubId']);
}
```

This means a client cannot self-upgrade by writing `tier: 'premium'` directly to Firestore.

The read side of this document has since widened: `allow read` is now
`isOwner(uid) || isAdmin()`, so the admin console can list users. The write
side is unchanged — the admin gets **no** write path to a user document.

---

## 7. Deployment & Testing

**Deploy** — from the **MarketCatalystUI** repo, not this one (§12):
```bash
firebase deploy --only firestore:rules
```

**Test rules locally with the Emulator:**
```bash
firebase emulators:start --only firestore
```

**Run the rules test suite** (add to `firestore.test.ts`):

Test cases to cover:
- Unauthenticated user cannot read any collection
- Free user cannot read `earnings_summaries`, `options_flow`, `block_trades`, `fund_holdings`, `recaps`
- Free user cannot read `story_stocks`
- Pro user can read `earnings_summaries`, `options_flow`, `block_trades`, `fund_holdings`, `recaps`
- Pro user cannot read `story_stocks`
- Premium user can read `story_stocks`
- User A cannot read `users/userB/portfolios`
- Client cannot write to `news`, `earnings_events`, or any market data collection
- Client cannot set `tier: 'premium'` on their own user document
- Client can mark notification as read but cannot change any other field
- Client cannot create a notification document
- User can create a `stock_comments` document with their own uid
- User cannot create a `stock_comments` document with another user's uid
- User can read their own `stock_comments` notes
- User cannot read another user's `stock_comments` notes
- User can delete their own `stock_comments` note
- User cannot update a `stock_comments` note (notes are immutable)

Added with the subscriptions/admin work (§9–§11):
- Non-admin cannot read `api_usage`, `audit_logs`, `revenue_summary`, `system_metrics`
- Admin can read `users/{otherUid}`; a non-admin user cannot
- Admin **cannot** write `users/{otherUid}` (read-only across users)
- Admin can update `plans/{id}.featureFlags`; the same update **fails** if it also touches `amount`, `currency` or `cycle`
- Admin cannot create or delete a `plans` document
- A user reads their own `payments` / `subscriptions` rows but not another user's
- No client can write `payments` or `subscriptions` at all
- A user can create a `feature_adoption` row for their own uid, but not for another uid
- `feature_adoption.openCount` update succeeds when it increases, fails when it decreases or stays equal
- A `feature_adoption` update that reassigns `userId` or changes `feature` fails
- No client can delete a `feature_adoption` row
- An authenticated user can read `market_sentiment`, `market_breadth`, `financials`, `intraday_bars`, `dividend_history` and `splits` (regression guard for §13 and the drift in §12)

> Whether a `firestore.test.ts` suite actually exists and runs is **unverified** —
> this section has always been written as cases to cover, not as a description of
> a passing suite.

**Testing a tier upgrade flow end-to-end:**
1. Stripe webhook fires → backend calls `admin.auth().setCustomUserClaims(uid, { tier: 'pro' })`
2. Client calls `getIdToken(true)` to force-refresh
3. Subsequent Firestore reads to `earnings_summaries` now succeed

---

## 8. Firestore Indexes (firestore.indexes.json)

Define these composite indexes alongside the rules deployment:

```json
{
  "indexes": [
    { "collectionGroup": "news",             "fields": [{ "fieldPath": "tickers",    "arrayConfig": "CONTAINS" }, { "fieldPath": "publishedAt", "order": "DESCENDING" }] },
    { "collectionGroup": "news",             "fields": [{ "fieldPath": "categories", "arrayConfig": "CONTAINS" }, { "fieldPath": "publishedAt", "order": "DESCENDING" }] },
    { "collectionGroup": "analyst_actions",  "fields": [{ "fieldPath": "ticker",     "order": "ASCENDING"  }, { "fieldPath": "publishedAt",  "order": "DESCENDING" }] },
    { "collectionGroup": "analyst_actions",  "fields": [{ "fieldPath": "actionType", "order": "ASCENDING"  }, { "fieldPath": "publishedAt",  "order": "DESCENDING" }] },
    { "collectionGroup": "earnings_events",  "fields": [{ "fieldPath": "reportDate", "order": "ASCENDING"  }, { "fieldPath": "session",      "order": "ASCENDING"  }] },
    { "collectionGroup": "earnings_events",  "fields": [{ "fieldPath": "reportDate", "order": "ASCENDING"  }, { "fieldPath": "resultPosted", "order": "ASCENDING"  }] },
    { "collectionGroup": "options_flow",     "fields": [{ "fieldPath": "ticker",     "order": "ASCENDING"  }, { "fieldPath": "tradeTime",    "order": "DESCENDING" }] },
    { "collectionGroup": "options_flow",     "fields": [{ "fieldPath": "isUnusual",  "order": "ASCENDING"  }, { "fieldPath": "tradeTime",    "order": "DESCENDING" }] },
    { "collectionGroup": "block_trades",     "fields": [{ "fieldPath": "ticker",     "order": "ASCENDING"  }, { "fieldPath": "tradeTime",    "order": "DESCENDING" }] },
    { "collectionGroup": "market_movers",    "fields": [{ "fieldPath": "date",       "order": "DESCENDING" }, { "fieldPath": "session",      "order": "ASCENDING"  }, { "fieldPath": "type", "order": "ASCENDING" }] },
    { "collectionGroup": "story_stocks",     "fields": [{ "fieldPath": "isActive",   "order": "ASCENDING"  }, { "fieldPath": "publishedAt",  "order": "DESCENDING" }] },
    { "collectionGroup": "companies",        "fields": [{ "fieldPath": "sector",     "order": "ASCENDING"  }, { "fieldPath": "marketCap",    "order": "DESCENDING" }] },
    { "collectionGroup": "companies",        "fields": [{ "fieldPath": "industryGroup", "order": "ASCENDING" }, { "fieldPath": "updatedAt",  "order": "DESCENDING" }] },
    { "collectionGroup": "stock_comments",   "fields": [{ "fieldPath": "uid",        "order": "ASCENDING"  }, { "fieldPath": "sym",          "order": "ASCENDING"  }, { "fieldPath": "createdAt", "order": "ASCENDING" }] }
  ]
}
```

> The deployed `firestore.indexes.json` also carries an `ohlcv_bars`
> (`ticker` + `barDate`) composite index, added 2026-07-08. Whether the rest
> of the list above is deployed as written is **unverified**.

---

## 9. Admin Access — the `isAdmin()` predicate

Added with the admin console. Two accepted proofs, in order of preference:

```js
function isAdmin() {
  return isAuthenticated()
         && (request.auth.token.admin == true
             || request.auth.token.email == 'admin@marketcatalyst.ai');
}
```

1. **Custom claim `admin: true`**, set server-side via the Admin SDK. This is
   independent of the email address, so rotating the admin's address needs no
   rules deploy.
2. **The fixed admin email.** Kept so access works before the claim
   propagates — a client only sees a new claim after its ID token refreshes.

**Two places, one value.** The address must stay in sync with `ADMIN_EMAIL` in
`deploy/env.production.yaml`, which the backend's `AdminGuard` checks. Change
one without the other and the admin screens and the admin API will disagree
about who is an admin.

### Why `email_verified` is deliberately NOT required

This is the part most likely to be "helpfully" "fixed" by a future reader, so
it is worth stating plainly:

- The admin is a **password account created out-of-band** and has
  `emailVerified = false`.
- Adding `&& request.auth.token.email_verified` therefore **locked the admin
  out of their own console** — while the backend `AdminGuard`, which does not
  check verification, kept admitting the exact same account. The two layers
  disagreed, which is the failure mode Principle 6 exists to avoid.
- Verification would add nothing here anyway: **Firebase enforces email
  uniqueness**, so no other account can hold this address. The check would
  gate on a property that cannot distinguish the real admin from an impostor,
  because an impostor with this address cannot exist.

Requiring verification is the right default for rules that trust
`token.email` for a *class* of users. It is not the right rule for a single
fixed address.

---

## 10. Billing Collections — `plans`, `payments`, `subscriptions`

Everything in this group is written **only** by the backend Admin SDK, with
the single narrow exception described below. Client writes are refused
outright: a client that could write `payments`, or its own `plans` document,
could grant itself a paid tier for free.

### `plans` — the admin may edit entitlements, and nothing else

```js
match /plans/{planId} {
  allow read: if isAuthenticated();

  allow update: if isAdmin()
                && request.resource.data.diff(resource.data)
                     .affectedKeys()
                     .hasOnly(['featureFlags', 'updatedAt'])
                && request.resource.data.featureFlags is map;

  allow create, delete: if false;
}
```

Read is open to any signed-in user so the upgrade screen can render the
pricing table.

The update rule is deliberately asymmetric:

- **`featureFlags` + `updatedAt` only.** `hasOnly()` means an update that
  touches *any* other key is rejected in full — the admin cannot smuggle a
  price change through alongside a legitimate entitlement edit.
- **Price, currency and billing cycle stay server-write-only.** Those must
  change together with the Stripe price object, and a client that could
  rewrite `amount` could set a plan to **$0** and then subscribe to it.
  Entitlements carry no equivalent risk: the worst case is granting or
  revoking access, which is exactly what this control is *for*.
- **Create and delete are denied.** The plan set is defined in code
  (`src/plans/plans.registry.ts`) and seeded by the backend; the seed is
  merge-based, so operator edits to `featureFlags` survive a re-seed.

Amounts in `plans` are **minor units (cents)** — `4999` is $49.99. Nothing in
the rules enforces that; it is a convention shared with Stripe.

Note that `featureFlags` on a plan is the **entitlement** set ("may this tier
use it?"), which is a different gate from the `feature_flags` collection in
§2.1 ("is it built and shipped?"). A feature is usable only when both are
true. They are not merged, because merging them would make an unbuilt feature
look like a paywall.

### `payments` and `subscriptions`

Identical visibility: the admin reads across all users, and a signed-in user
reads only rows whose `userId` matches their uid.

```js
allow read:  if isAdmin()
             || (isAuthenticated() && resource.data.userId == request.auth.uid);
allow write: if false;
```

Both collections are currently **empty** — Stripe is not implemented, so
nothing writes them yet. The rules are in place ahead of that work.

---

## 11. Analytics Collections — and the one client-writable exception

`api_usage`, `audit_logs`, `revenue_summary` and `system_metrics` are all
`allow read: if isAdmin()` / `allow write: if false`. Read is admin-only
because per-user API call logs and feature usage are behavioural data about
identifiable people, not market data.

### `feature_adoption` — the only client-writable analytics collection

One document per `(feature, user)`, id `{feature}__{uid}`.

**Why it is client-written.** The browser cannot currently reach the backend
(`NEXT_PUBLIC_BACKEND_URL` is unset, so `http://localhost:4400` is baked into
the production bundle and blocked as mixed content). A server-mediated write
is therefore not available, and the alternative was to ship no adoption data
at all.

**The trade-off, stated explicitly.** A signed-in user **can inflate their own
counters.** That is acceptable here: this is adoption analytics, not billing,
and the blast radius is one user's own row. It is *not* acceptable for
`payments` or `subscriptions`, which is why those stay server-write-only in
§10. **This should move server-side once the Firebase Hosting rewrite to
Cloud Run lands** and the browser can reach the backend.

What the rules still pin down:

```js
match /feature_adoption/{docId} {
  allow read: if isAdmin()
              || (isAuthenticated() && resource.data.userId == request.auth.uid);

  allow create: if isAuthenticated()
                && request.resource.data.userId == request.auth.uid
                && request.resource.data.feature is string
                && request.resource.data.feature.size() <= 64
                && request.resource.data.openCount is int
                && request.resource.data.openCount >= 0;

  allow update: if isAuthenticated()
                && resource.data.userId == request.auth.uid
                && request.resource.data.userId == resource.data.userId
                && request.resource.data.feature == resource.data.feature
                && request.resource.data.openCount is int
                && request.resource.data.openCount > resource.data.openCount;

  allow delete: if false;
}
```

- The row must **belong to the caller** on both create and update.
- **Ownership cannot change hands** — `userId` and `feature` are pinned to
  their existing values on update.
- The counter may only **move forward** (`>`, not `>=`), so a client can add
  to its own history but never rewrite or erase it.
- **Delete is denied outright.**

Net effect: the worst a malicious client can do is make its own adoption
numbers too high. It cannot suppress them, touch another user's row, or read
across users.

---

## 12. ⚠ Rules File Drift Between the Two Repos

**Both repos ship a `firestore.rules`. Only one of them is real.**

| | Path | Status |
|---|---|---|
| **LIVE** | `MarketCatalystUI/firestore.rules` | Deployed ruleset. Source of truth. Edit **this** one. |
| stale | `MarketCatalystBackEnd/firestore.rules` | **DO NOT DEPLOY.** Kept only because the backend's `firebase.json` still references it. |

The files have drifted in **both directions**, so neither is a superset and
copying either over the other loses rules:

| | Collections present |
|---|---|
| Only in the backend copy | `market_sentiment`, `stock_comments`, `sync_meta`, `sync_watermarks` |
| Only in the live UI copy | `financials`, `market_breadth`, `intraday_bars`, `dividend_history`, `splits`, `feature_flags`, `plans`, `payments`, `subscriptions`, `api_usage`, `audit_logs`, `revenue_summary`, `system_metrics`, `feature_adoption`, and the `users/{uid}` sub-collections (`alerts`, `notifications`, `watchlists`, `portfolios`, `holdings`) plus `fund_holdings`' `filings` / `positions` |

**Deploying the backend copy would remove read access to `financials` and
`market_breadth`**, breaking Stock Detail and the Dashboard internals — along
with everything else in the second row. The backend file now carries a
`⚠ DO NOT DEPLOY THIS FILE` header saying exactly this.

`sync_meta` and `sync_watermarks` appear in the backend copy but **not** in the
live ruleset, so client reads of them are currently denied by the catch-all.
That is harmless if only the Admin SDK touches them — the Admin SDK bypasses
rules entirely — but whether any client code reads them is **unverified**.

**If you change the rules:** edit `MarketCatalystUI/firestore.rules`, deploy
from that repo, and update this document. Do not "sync" the two files.

---

## 13. Collections That Previously Had No Rule (fixed 2026-07-22)

Firestore's catch-all denial is silent from the rules' point of view — a
missing `match` block is indistinguishable from a deliberate denial, and the
failure surfaces only as a `permission-denied` in the client. Two collections
were being written correctly by the backend and read by the UI, but had **no
`match` block at all** in the live ruleset:

- **`market_sentiment`** — the composite Fear & Greed reading written by
  `fear-greed.job` to `market_sentiment/fear_greed`. Every read was rejected,
  so the Dashboard gauge fell back to its **hardcoded 62 / "Greed"**. The job
  had been writing real values the UI could never see.
- **`stock_comments`** — user notes pinned to a chart (§3). Both reads and
  writes failed, so the chart-notes feature failed silently.

Both now have explicit rules in the live ruleset: `market_sentiment` is
authenticated-read / server-write (§2.1), and `stock_comments` is owner-scoped
with immutable notes (§2.4, §3).

**The lesson worth keeping:** a collection that the backend writes is not
reachable by the client until a `match` block exists for it. This is why
`splits` is declared in §2.1 with no UI consumer yet — so the read is already
allowed when a consumer lands, instead of failing silently and being
misdiagnosed as a data problem.
