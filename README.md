# Market Catalyst Backend

The **data-ingestion service** for Market Catalyst. Market-wide data (indices,
movers, sectors, earnings, news, etc.) is filled by ONE daily batch job
(`premarket`, 08:00 ET weekdays); per-ticker data (company profile, bars) is
filled **on demand** the first time any user asks for it. Either way, results
land in **Cloud Firestore**, and the Next.js frontend reads most of it back
directly via the client SDK. It never holds a vendor API key.

```
Vendor APIs (Polygon, FMP, Finnhub, FRED, SEC EDGAR)
        │
        ├─ premarket job (@nestjs/schedule, 08:00 ET weekdays)
        │     → market-wide + per-ticker batch collections
        │
        └─ GET /live/bars, /live/company  (on-demand, cache-aside)
              → per-ticker collections, populated on first request
        ▼
   Cloud Firestore   ← written server-side via the Firebase Admin SDK
        │   onSnapshot() real-time reads (Firestore client SDK) for most
        │   screens, PLUS direct HTTP calls to /live/bars + /live/company
        │   (see MarketCatalystUI's useOhlcvBars / useEnsureCompanies hooks)
        │   to trigger the on-demand fetch in the first place
        ▼
   Next.js app (separate repo)  — every live screen element
```

> Market-wide collections have no on-demand path — they only refill via the
> `premarket` job. If Firestore was just emptied, expect those screens to stay
> blank until the next scheduled run (or trigger it manually — see
> `deploy/DEPLOY.md` §6, `POST /sync/premarket/run`).

This is a NestJS app. Vendor calls go through an **adapter layer** (`src/adapters/`)
with automatic fallback between two vendors for company profiles, movers, mover
enrichment, and news. Client-owned data (watchlists, portfolios, notes) is written
by the frontend directly, never through this service.

> **Data contract & status:** `Doc/screen-data-sources.md` (per-screen breakdown of
> what's live vs. mock), `Doc/openapi.yaml` (documented contract), and
> `Doc/06_Firestore_Security_Rules.md` (collection access model).

---

## Quick start (local)

```bash
cp .env.example .env      # fill in real vendor API keys
# keep a Firebase service-account.json at the repo root for local Firestore access
npm install
npm run start:dev         # http://localhost:4100
```

- **Ops monitor UI:** http://localhost:4100/ (job status dashboard, served by NestJS)
- **Health:** `GET /health`
- **Ops API:** `GET /sync/jobs`, `GET /sync/status`, `POST /sync/:job/run`, `POST /sync/run-all`

The build/run scripts (`npm run build`, `start`, `start:dev`, `start:prod`, `test`,
`lint`) are the standard Nest ones.

---

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example)
for the full list. Essentials:

| Var | Purpose |
|---|---|
| `FIREBASE_PROJECT_ID` | GCP/Firebase project to write to — **must match the frontend's project** |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Local only; on Cloud Run leave unset (uses Application Default Credentials) |
| `POLYGON_API_KEY`, `FMP_API_KEY`, `FINNHUB_API_KEY`, `FRED_API_KEY` | Core vendor keys |
| `SEC_EDGAR_USER_AGENT` | Required contact string for SEC EDGAR |
| `*_SOURCE` / `*_FALLBACK_SOURCE`, `NEWS_SOURCE` | Adapter vendor routing |
| `BENZINGA_API_KEY`, `TRADIER_ACCESS_TOKEN`, `UNUSUAL_WHALES_API_KEY`, `SENTRY_DSN` | Optional; jobs degrade gracefully when blank |

Firestore access is server-only via the Admin SDK (`src/common/firebase-admin.provider.ts`),
which bypasses security rules. Locally it uses `service-account.json`; on Cloud Run
it uses the runtime service account's Application Default Credentials.

---

## Sync jobs

21 jobs, each writing the Firestore collection(s) below. They no longer self-schedule
individually — **one** Cloud Scheduler entry (`sync-premarket`, 08:00 ET weekdays) hits
`POST /sync/premarket/run`, which runs all of them in dependency-ordered phases (see
`src/sync/premarket.job.ts`). The `cronExpression` shown per job is now just registry
metadata (surfaced on `GET /sync/jobs`) describing how often that job *used to* run
standalone — not a live trigger. Each job can still be fired individually via
`POST /sync/:job/run` for manual backfills/debugging.

Per-ticker company + bars data additionally fills **on demand**: `companies` and
`stock_bars` are also written by `GET /live/bars` / `GET /live/company` the first
time any user's browser requests a ticker (see `src/live/ondemand.service.ts`) —
that path is what the frontend actually calls day to day; the batch schedule below
is the once-a-day floor, not the only way these collections fill.

| Job | Schedule (ET) | Writes collection(s) |
|---|---|---|
| `sec-13f` | `0 1 * * *` | `fund_holdings/{cik}/filings/{id}/positions` |
| `sec-form4` | `30 1 * * *` | `insider_transactions` |
| `companies` | `0 2 * * *` | `companies` |
| `stock-history` | `0 3 * * *` | `ohlcv_bars` |
| `ticker-universe` | `0 3 * * 0` (weekly) | `tickers` |
| `rs-rating` | `0 4 * * *` | `companies` (RS score) |
| `technical-indicators` | `10 4 * * *` | `companies` (RSI/MACD/RVOL) |
| `tech-rating` | `15 4 * * *` | `companies` (tech rating + sector rank) |
| `fundamentals-growth` | `30 4 * * *` | `companies` (growth/margin) |
| `analyst-actions` | `0 6 * * *` | `analyst_actions` |
| `earnings` | `0 6 * * *` | `earnings_events` |
| `ipos` | `15 6 * * *` | `ipos` |
| `dividends` | `20 6 * * *` | `dividends` |
| `news` | `*/30 9-16 * * 1-5` | `news` |
| `market-indices` | `5 18 * * 1-5` | `market_indices`, `market_indices_history` |
| `market-quotes` | `7 18 * * 1-5` | `tickers` (price/%/vol) |
| `sectors` | `0 18 * * 1-5` | `sectors`, `sectors_history` |
| `market-movers` | `0 18 * * 1-5` | `market_movers`, `market_movers_history` |
| `macro-events` | `10 18 * * 1-5` | `macro_events` |
| `fear-greed` | `15 18 * * 1-5` | `market_sentiment/fear_greed` |
| `options-chains` | `0 19 * * 1-5` | `options_chains` |

Run-history/metadata is persisted to `sync_meta/{job}` on every run; `sync_watermarks`
tracks incremental cursors.

---

## Deployment (Firebase / GCP)

Two Cloud Run services from the same image (worker + public `live`), plus **one**
Cloud Scheduler job (`sync-premarket`) triggering the batch orchestrator over HTTP.
Full step-by-step runbook: **[`deploy/DEPLOY.md`](deploy/DEPLOY.md)**.

Deploy artifacts in this repo:
- [`Dockerfile`](Dockerfile) — multi-stage container (uses ADC, no baked key)
- [`firebase.json`](firebase.json) + [`firestore.rules`](firestore.rules) + [`firestore.indexes.json`](firestore.indexes.json) — Firestore config
- [`deploy/create-scheduler-jobs.sh`](deploy/create-scheduler-jobs.sh) — creates the single `sync-premarket` job and deletes any leftover per-job schedules
- [`deploy/empty-market-data.mjs`](deploy/empty-market-data.mjs) — resets market-data collections to the on-demand shape (never touches users/plans/settings)

> Requires the Firebase project on the **Blaze** plan (Cloud Run + Scheduler +
> backfill write-bursts). The project must be the **same** one the frontend reads from.

---

## Project structure

```
src/
├── main.ts                  # bootstrap (Sentry, CORS, shutdown hooks)
├── app.module.ts            # root module (Config, Schedule, ServeStatic, Common, Sync, Wave3)
├── health/                  # GET /health
├── common/                  # FirebaseAdminService, SyncRegistry, SyncMetaService, utils, universes
├── vendors/                 # Polygon, FMP, Finnhub, FRED, SEC EDGAR, Tradier, Benzinga, Unusual Whales
├── adapters/                # canonical types + composite/fallback adapters (profiles, movers, news)
└── sync/                    # 21 *.job.ts + sync.controller.ts + sync.module.ts
public/                      # ops monitor UI (served at /)
deploy/                      # Cloud Run + Cloud Scheduler deploy scripts + runbook
Doc/                         # product/architecture docs and data contract
```
