# Market Catalyst Backend

The **data-ingestion service** for Market Catalyst. It pulls market data from
vendor APIs on scheduled cron jobs and writes the results into **Cloud Firestore**.
The Next.js frontend reads those Firestore collections directly via the client SDK
— it never calls this service and never holds a vendor API key.

```
Vendor APIs (Polygon, FMP, Finnhub, FRED, SEC EDGAR)
        │   21 scheduled sync jobs (@nestjs/schedule)
        ▼
   Cloud Firestore   ← written server-side via the Firebase Admin SDK
        │   onSnapshot() real-time reads (Firestore client SDK)
        ▼
   Next.js app (separate repo)  — every live screen element
```

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

21 jobs, each with a fixed `@Cron(...)` schedule (America/New_York) and the Firestore
collection(s) it writes. In production these are driven by **Cloud Scheduler** (see
Deployment); locally the in-process `@nestjs/schedule` cron fires them.

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

Runs on **Cloud Run** (scale-to-zero) with **Cloud Scheduler** triggering each job
over HTTP. Full step-by-step runbook: **[`deploy/DEPLOY.md`](deploy/DEPLOY.md)**.

Deploy artifacts in this repo:
- [`Dockerfile`](Dockerfile) — multi-stage container (uses ADC, no baked key)
- [`firebase.json`](firebase.json) + [`firestore.rules`](firestore.rules) + [`firestore.indexes.json`](firestore.indexes.json) — Firestore config
- [`deploy/create-scheduler-jobs.sh`](deploy/create-scheduler-jobs.sh) — creates all 21 Cloud Scheduler jobs from the schedules above

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
