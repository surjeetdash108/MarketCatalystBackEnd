# Deploying Market Catalyst Backend to Firebase / GCP (Cloud Run + Cloud Scheduler)

This backend both **ingests** (pulls from vendor APIs → writes Firestore) and
**serves** the frontend: the Next.js app calls this service's REST/SSE surface
(`/api`, `/market-data`, `/live`) — same-origin in production, proxied by
Firebase Hosting rewrites to the public `market-catalyst-live` Cloud Run service.
(An earlier design had the frontend read Firestore directly; it no longer does.)

> **Two environments.** Everything below is written per-environment. Production
> is project `market-catalyst-502415`; **stage** is the isolated project
> `market-catalyst-stage` (own Firestore/Auth/rules/service-account, own
> `market-catalyst-live`/`market-catalyst-backend` services). Pick the target by
> setting `PROJECT_ID` in §0 (and use the matching `deploy/env.<env>.yaml`).
> `.firebaserc` provides `stage`/`prod` aliases for `--project`.

**Runtime model:** the app is a NestJS server. On Cloud Run the worker service
(`market-catalyst-backend`) runs **scale-to-zero** (`--min-instances=0`, CPU
throttled — the Cloud Run default, do **not** pass `--no-cpu-throttling`) and
**Cloud Scheduler** triggers the short intraday sync jobs over HTTP
(`POST /sync/<job>/run`) on their schedule; the instance cold-starts per trigger
and bills per request. The in-process `@nestjs/schedule` cron is **not** the
driver in production (a scaled-to-zero instance has no warm process to fire it)
— Cloud Scheduler is.

> **2026-08-16 — scale-to-zero cost cut (bill ~$75–90/mo → <$15/mo).** The worker
> was previously always-on (`--min-instances=1` + `--no-cpu-throttling`, ≈$65/mo)
> *only* to host the detached premarket bundle, which returns `202` and keeps
> running past Cloud Run's 900s request limit. That bundle now runs as a separate
> **Cloud Run Job** `premarket-job` (§3c), so the worker can scale to zero.
> Scale-to-zero is safe because the worker's remaining `@Cron` handlers
> (auto-purge/retention) are gated off (`ENABLE_SCHEDULED_JOBS` unset → no-ops)
> and the `@Interval` metering flush (`api-usage.service`) flushes on
> `onModuleDestroy`/SIGTERM — the same pattern already proven on the
> scale-to-zero live service.

Prerequisites: a **Blaze** (pay-as-you-go) Firebase project — Cloud Run, Cloud
Scheduler, and the backfill write-bursts all require it. `gcloud` + `firebase` CLIs
installed and authenticated.

---

## 0. Variables

```bash
# Pick ONE environment:
export PROJECT_ID=market-catalyst-502415   # production
# export PROJECT_ID=market-catalyst-stage  # stage
export REGION=us-central1
export ENV_FILE=deploy/env.production.yaml # use deploy/env.stage.yaml for stage
gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com
```

> ⚠ **Project ID must match the frontend build.** The backend writes to and
> serves `$PROJECT_ID`; the Next.js build must target the same project (backend
> `FIREBASE_PROJECT_ID` in the env file == the UI's `NEXT_PUBLIC_FIREBASE_PROJECT_ID`),
> or the app authenticates against one project and reads an empty database in
> another. Prod: both `market-catalyst-502415`. Stage: both `market-catalyst-stage`.
>
> ⚠ **Billing (Blaze) required.** Cloud Run, Cloud Scheduler, the backfill
> write-bursts, **and** the Firebase Hosting Cloud Run rewrites all need billing
> linked on `$PROJECT_ID`. A free-tier project can host the static UI but cannot
> run the backend or proxy `/api`·`/market-data`·`/live`.

## 1. Deploy Firestore rules + indexes

```bash
firebase deploy --only firestore:rules,firestore:indexes --project "$PROJECT_ID"
```

(If the **frontend** repo already ships `firestore.rules` / `firestore.indexes.json`,
pick ONE repo as the source of truth to avoid overwriting each other.)

### Why `firestore.indexes.json` only has 3 indexes (pruned 2026-07-20)

It previously declared 15. Twelve were removed because they indexed **fields the
jobs never write**, so no query could ever use them — they cost index storage and
add write latency to every document for nothing:

| Removed index | Why it could never match |
|---|---|
| `news.tickers` / `news.categories` (array-contains) | `news.job.ts` writes the **scalars** `ticker` and `category`, not arrays |
| `analyst_actions.ticker+publishedAt`, `.actionType+publishedAt` | that job writes `updatedAt`; it has no `publishedAt` and no `actionType` |
| `earnings_events.reportDate+session`, `.reportDate+resultPosted` | job writes `date`; `session` and `resultPosted` have no source at all |
| `market_movers.date+session+type` | job writes `asOfDate` and `direction` — none of those three fields exist |
| `companies.industryGroup+updatedAt` | `industryGroup` appears nowhere in the repo, openapi.yaml, or schema.sql |
| `options_flow` ×2, `block_trades`, `story_stocks` | no job writes these collections; they are empty |

**Kept**, all three verified against real writes:
- `companies.sector+marketCap` — both fields written by `companies.job.ts`
- `ohlcv_bars.ticker+barDate` — required by the only three composite queries in the
  codebase (`rs-rating`, `tech-rating`, `technical-indicators`)
- `stock_comments.uid+sym+createdAt` — **kept deliberately.** This collection is
  written by the frontend via the client SDK, not by this backend, so its fields
  cannot be verified from this repo. Removing it could break a live frontend query.

Re-adding an index later is a one-line change plus a rebuild, so pruning is
low-risk: an index that matches no documents cannot be load-bearing.

## 2. Store vendor API keys in Secret Manager

Never bake keys into the image. Create a secret per key (values from your `.env`):

```bash
for K in POLYGON_API_KEY FINNHUB_API_KEY FRED_API_KEY \
         BENZINGA_API_KEY TRADIER_ACCESS_TOKEN UNUSUAL_WHALES_API_KEY SENTRY_DSN; do
  printf "%s" "PASTE_${K}_VALUE" | gcloud secrets create "$K" --data-file=- 2>/dev/null \
    || printf "%s" "PASTE_${K}_VALUE" | gcloud secrets versions add "$K" --data-file=-
done
```

## 2b. Grant the runtime service account its two roles — BEFORE deploying

Do this first. Cloud Run resolves `--set-secrets` while *creating the revision*,
so without `secretmanager.secretAccessor` the image builds successfully and then
the deploy fails at the last step with `Permission denied on secret: ...` — several
minutes wasted on a build that was never going to land.

```bash
RUNTIME_SA="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
for ROLE in roles/secretmanager.secretAccessor roles/datastore.user; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$RUNTIME_SA" --role="$ROLE" --condition=None --quiet
done
```

- `secretmanager.secretAccessor` — read the four API keys at revision-creation time.
- `datastore.user` — write to Firestore at runtime. Without it the service boots
  fine and then *every* job fails on its first write.

## 3. Deploy the service to Cloud Run

**There are two services, built from one image**, selected by `APP_ROLE`:

| | `market-catalyst-backend` (worker) | `market-catalyst-live` (live) |
|---|---|---|
| `APP_ROLE` | `worker` (in `env.production.yaml`) | `live` |
| Reachable by | Cloud Scheduler / `gcloud proxy` only | **the public internet** |
| Mounts | everything: sync, purge, retention, flags, plans, ops UI at `/` | `LiveModule` + `/health` **only** |
| `--timeout` | `900` (batch jobs) | `3600` (long-lived SSE) |
| Scaling | `--min-instances=0`, CPU throttled (scale-to-zero) | `--min-instances=0` |
| Workload | short intraday sync jobs (§5) + admin/ops — the long premarket bundle is now the separate `premarket-job` Cloud Run Job (§3c) | ticker-tape SSE fan-out |

**Why two and not one.** The browser has to hold an open connection to
`/live/tape/stream`, so that service must be `--allow-unauthenticated`. On the
worker, `AdminGuard` treats *no* `Authorization` header as authorised whenever
`ADMIN_GUARD_TRUST_IAM=true` — correct there, because `--no-allow-unauthenticated`
means Cloud Run IAM vetted the caller first. Making that same service public
would turn the shortcut into anonymous `/purge` and `/sync`. `APP_ROLE=live`
never registers those modules, so the public service has no admin routes to
guard rather than a guard that must stay configured correctly forever. Verified
locally: with `APP_ROLE=live`, `/admin/revenue` returns **404** where the worker
returns **200** to the same unauthenticated request.

Uses the `Dockerfile` at the repo root (source deploy builds it via Cloud Build):

```bash
gcloud run deploy market-catalyst-backend \
  --source . \
  --region "$REGION" \
  --no-allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --memory=512Mi \
  --timeout=900 \
  --env-vars-file="$ENV_FILE" \
  --set-secrets="POLYGON_API_KEY=POLYGON_API_KEY:latest,FINNHUB_API_KEY=FINNHUB_API_KEY:latest,FRED_API_KEY=FRED_API_KEY:latest"
```

> **`--min-instances=0` + default CPU throttling is intentional (2026-08-16).**
> The worker only handles short scheduled jobs + admin now, so it scales to zero
> and bills per request. Do **not** re-add `--min-instances=1` or
> `--no-cpu-throttling` — those were only needed for the old detached premarket
> run, which is now the `premarket-job` Cloud Run Job (§3c).

> ⚠ **`POLYGON_PAGE_DELAY_MS=0` is required, not optional.** It lives in
> `deploy/env.production.yaml`. The code default is `12500` (the FREE tier's
> 5-calls-per-minute budget). Deploying with that default makes
> `options-chains` sleep 168 times per run ≈ **35 minutes**, which exceeds both
> `--timeout=900` above and the Scheduler `--attempt-deadline=900s` — so that
> job fails on *every* run, and `stock-history` / `fundamentals-growth` burn
> ~12.5 min of pure sleeping before any API call. Every paid Massive tier is
> unlimited-rate, so 0 is correct for a paid key. If you ever downgrade to the
> free Basic plan, raise this back to `12500` **and** split those jobs into
> smaller batches, because they will not fit in 900s at that rate.

### 3b. Deploy the public live service (ticker tape)

Same image, different role and *very* different Cloud Run settings:

```bash
# Reuse the image the deploy above built, so both services run identical code.
IMAGE=$(gcloud run services describe market-catalyst-backend --region "$REGION" \
          --format='value(spec.template.spec.containers[0].image)')

gcloud run deploy market-catalyst-live \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=5 \
  --concurrency=200 \
  --memory=1Gi \
  --timeout=3600 \
  --set-env-vars="APP_ROLE=live,NODE_ENV=production,FIREBASE_PROJECT_ID=market-catalyst-502415,POLYGON_API_BASE_URL=https://api.massive.com,CORS_ORIGINS=https://marketcatalyst.web.app,POLYGON_PAGE_DELAY_MS=0,ADMIN_GUARD_TRUST_IAM=false" \
  --set-secrets="POLYGON_API_KEY=POLYGON_API_KEY:latest"
```

> ⚠ **`ADMIN_GUARD_TRUST_IAM=false` is REQUIRED here — omitting it is a data
> leak.** Admin read-models are mounted on the live role (commit b73851a), and
> `admin.guard.ts` defaults `ADMIN_GUARD_TRUST_IAM` to `true` ("trust that Cloud
> Run IAM already vetted the caller"). This service is `--allow-unauthenticated`
> — there is no IAM in front — so with the default, every `/admin/*` call is
> served to ANYONE (revenue, user counts, subscriptions). `false` forces a
> verified Firebase admin token instead. It is NOT in the current service env by
> default; verify with the `/admin/revenue -> 401` check below after every deploy.
>
> ⚠ **`--set-env-vars`, NOT `--env-vars-file`.** `deploy/env.production.yaml` is
> the *worker's* env and carries `APP_ROLE=worker` plus
> `ADMIN_GUARD_TRUST_IAM=true`. Pointing the public service at it would both
> re-mount the admin modules and re-enable the trust-IAM shortcut on an
> `--allow-unauthenticated` service — the exact combination that grants
> anonymous `/purge`. The list above is short precisely because the live role
> needs almost nothing.
>
> ⚠ **`POLYGON_PAGE_DELAY_MS=0` is required here too, not just on the worker.**
> `TickerSearchService` (backing `GET /live/search`, the app's ticker-search box
> everywhere it appears) calls `PolygonService.getAllTickers()` on this service
> to lazily load the ~10k-ticker universe on first search per instance. Omitting
> this var — as an earlier version of this command did — leaves it on the code
> default of 12,500ms **per page**; at ~10-11 pages for the full universe that's
> 2+ minutes of silent hang on every cold start (this service runs
> `--min-instances=0`, so that's not rare). Confirmed and fixed in production
> 2026-07-31: search went from >120s to ~2s once this var was added via
> `gcloud run services update market-catalyst-live --update-env-vars=POLYGON_PAGE_DELAY_MS=0`.

Three of these settings are load-bearing; the defaults silently break SSE:

- **`--timeout=3600`.** The worker's `900` would sever every stream at 15
  minutes. 3600s is Cloud Run's ceiling; `EventSource` reconnects on its own
  when it is hit, so the user sees nothing.
- **`--concurrency=200`.** SSE connections are long-lived, so concurrency is a
  hard ceiling on **simultaneous viewers**, not a throughput knob: the default
  80 caps the service at `80 x max-instances`. Measured cost is ~156 KB RSS per
  connected client, so 200 ≈ 31 MB — comfortable in 1Gi, and 200 x 5 instances
  = 1,000 concurrent viewers.
- **`--min-instances=0` is deliberate.** An open SSE connection keeps an
  instance warm by itself, and `TapeService`'s poller is ref-counted against
  connected clients, so an app nobody has open makes zero vendor calls and costs
  nothing. Only the first viewer after an idle period pays a cold start.

**No Cloud Scheduler entry is needed for the tape** — the 60s poller lives in
the process and starts on the first viewer. Do not add one to
`create-scheduler-jobs.sh`.

**Frontend wiring — no per-deploy URL step.** The UI resolves its backend base
URL at runtime (`app/iq/backend.ts`): `localhost:4400` in dev, **same-origin**
when deployed. `firebase.json` rewrites `/api/**`, `/market-data/**` and
`/live/**` to this `market-catalyst-live` service, so nothing hardcodes the
Cloud Run URL. Requirements: the UI's Hosting site and this service live in the
**same project**, the rewrites are present in `firebase.json` (they need Cloud
Run API + billing to deploy), and this service is named `market-catalyst-live`.
`NEXT_PUBLIC_BACKEND_URL` is only an optional non-localhost override for pointing
a local UI at a remote backend.

```bash
gcloud run services describe market-catalyst-live --region "$REGION" --format='value(status.url)'
# informational for REST (reached via the same-origin Hosting rewrite) — but see
# the SSE note below: this URL IS baked into the UI for live streaming.
```

**Live streaming (SSE) — one per-deploy URL step.** REST goes same-origin so
Hosting can CDN-cache it, but Hosting's CDN **buffers a long-lived streaming
response**, so an EventSource opened at the same-origin `/live/**` rewrite never
receives a frame. That is why the tape and the stock live-price/chart hooks
(`useTapeStream`, `useLiveTick`) each carry a REST poll fallback — without the
step below, production runs on that poll (tape 20s, price 30s), not true push.

To get true SSE push in production, point the browser's EventSource straight at
this Cloud Run service, bypassing Hosting. The UI reads
`NEXT_PUBLIC_LIVE_STREAM_ORIGIN` (baked at build time — the UI is a static
`output: "export"`, so it must be a `NEXT_PUBLIC_*` var) and uses it only for the
SSE endpoints (`app/iq/backend.ts` → `streamUrl()`); REST stays same-origin.

```bash
# Build the UI with the live service URL as the SSE origin, then deploy Hosting:
export NEXT_PUBLIC_LIVE_STREAM_ORIGIN=$(gcloud run services describe market-catalyst-live \
  --region "$REGION" --format='value(status.url)')
( cd ../../MarketCatalystUI && npm run build && firebase deploy --only hosting )
```

This works cross-origin because the `live` service's CORS allowlist already
includes the Hosting origin (`CORS_ORIGINS=https://marketcatalyst.web.app`,
`credentials:false` in `main.ts`) and both SSE streams are public, so
EventSource's inability to send an `Authorization` header is a non-issue. If you
serve the UI from a different Hosting domain, add it to `CORS_ORIGINS` on this
service too, or the browser will block the stream. Leaving
`NEXT_PUBLIC_LIVE_STREAM_ORIGIN` unset is safe — the UI falls back to the poll.

Verify after deploying:

```bash
LIVE=$(gcloud run services describe market-catalyst-live --region "$REGION" --format='value(status.url)')
curl -s "$LIVE/live/tape" | jq '.items | length'      # -> 21
curl -s -o /dev/null -w '%{http_code}\n' "$LIVE/admin/revenue"   # -> 401 (admin IS mounted on live since b73851a, but guard-protected); NEVER 200-with-data
curl -s "$LIVE/live/tape/stats"   # upstreamCalls must stay ~1/min as clients grows
```

> **Env vars live in `deploy/env.production.yaml`**, not inline — including
> `FIREBASE_PROJECT_ID`. Two reasons: `--set-env-vars` is comma-delimited, so with
> ~25 variables a single comma inside a value silently corrupts the set; and
> gcloud treats `--env-vars-file` and `--set-env-vars` as **mutually exclusive**,
> failing with a bare usage dump if you pass both. If you deploy to a different
> project, change `FIREBASE_PROJECT_ID` in the YAML.

Notes:
- **No `service-account.json`.** The app uses Application Default Credentials from
  the Cloud Run runtime service account — the roles it needs are granted in §2b
  above, which must run *before* this step.
- `--no-allow-unauthenticated` keeps `/sync/*` private — only Scheduler (below)
  can invoke it. (The ops monitor at `/` is then also private; reach it via
  `gcloud run services proxy` or make a separate authenticated path if you want it public.)
- `FIREBASE_SERVICE_ACCOUNT_PATH` is intentionally unset → ADC is used.

Grab the URL:
```bash
export SERVICE_URL=$(gcloud run services describe market-catalyst-backend --region "$REGION" --format='value(status.url)')
```

### 3c. Deploy the premarket Cloud Run **Job** (2026-08-16)

The premarket bundle runs ~18 min/weekday — past Cloud Run's 900s request limit —
so it is **not** a request on the worker service anymore. It runs as a **Cloud Run
Job** `premarket-job` built from the *same image*, overriding the entrypoint to
`node dist/job-entry.js` (`src/job-entry.ts` boots a Nest application context via
`src/app-job.module.ts` — the worker's modules **minus** `ServeStaticModule`,
which crashes a no-HTTP context — then runs `SyncRegistry.get(SYNC_JOB ?? "premarket")()`
and exits). This is what lets the worker service scale to zero.

```bash
# Reuse the image the worker deploy built, so the job runs identical code.
IMAGE=$(gcloud run services describe market-catalyst-backend --region "$REGION" \
          --format='value(spec.template.spec.containers[0].image)')

gcloud run jobs create premarket-job \
  --image "$IMAGE" \
  --region "$REGION" \
  --command="node" --args="dist/job-entry.js" \
  --task-timeout=3600 \
  --max-retries=1 \
  --memory=2Gi --cpu=1 \
  --service-account="backend-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --env-vars-file="$ENV_FILE" \
  --set-secrets="POLYGON_API_KEY=POLYGON_API_KEY:latest,FINNHUB_API_KEY=FINNHUB_API_KEY:latest,FRED_API_KEY=FRED_API_KEY:latest"
# Redeploy after a code change: same command with `jobs update` instead of `jobs create`
# (or `gcloud run jobs deploy premarket-job --source . --command=node --args=dist/job-entry.js …`).
```

Run it manually (this replaces the retired `POST /sync/premarket/run` — that
detached path would be killed on the now scale-to-zero worker):

```bash
gcloud run jobs execute premarket-job --region "$REGION"          # fire-and-forget
gcloud run jobs execute premarket-job --region "$REGION" --wait   # block until it exits
```

`SYNC_JOB` defaults to `premarket`; set it to any registered sync name to reuse
the same image+entrypoint for a single job (`--update-env-vars=SYNC_JOB=<name>`).
Its Cloud Scheduler trigger `run-premarket-job` is created in §5.

## 4. Create the Scheduler invoker service account

```bash
gcloud iam service-accounts create scheduler-invoker --display-name="Cloud Scheduler → Cloud Run invoker"
export INVOKER_SA="scheduler-invoker@${PROJECT_ID}.iam.gserviceaccount.com"
# HTTP invoke on the worker service (intraday sync schedulers):
gcloud run services add-iam-policy-binding market-catalyst-backend \
  --region "$REGION" --member="serviceAccount:${INVOKER_SA}" --role="roles/run.invoker"
# Run Admin API invoke on the JOB (the run-premarket-job scheduler, §5):
gcloud run jobs add-iam-policy-binding premarket-job \
  --region "$REGION" --member="serviceAccount:${INVOKER_SA}" --role="roles/run.invoker"
```

## 5. Create the scheduler jobs (2026-08-16 — Job trigger + 5-min intraday)

Two kinds of Cloud Scheduler entry now, both as `scheduler-invoker@`:

**(a) `run-premarket-job` — triggers the Cloud Run Job (§3c).** 08:00 ET
weekdays. It does **not** POST to the worker; it calls the Run Admin API to
execute the job, authenticated with an OAuth token (needs `roles/run.invoker`
on the job, granted in §4). The old `sync-premarket` HTTP scheduler is DELETED.

```bash
gcloud scheduler jobs create http run-premarket-job \
  --project="$PROJECT_ID" --location="$REGION" \
  --schedule="0 8 * * 1-5" --time-zone="America/New_York" \
  --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/premarket-job:run" \
  --http-method=POST \
  --oauth-service-account-email="$INVOKER_SA" \
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"

# Retire the old HTTP premarket scheduler if it still exists:
gcloud scheduler jobs delete sync-premarket --project="$PROJECT_ID" --location="$REGION" --quiet 2>/dev/null || true
```

**(b) Intraday HTTP sync schedulers — every 5 min during the session.** OIDC
POST to `/sync/<job>/run` on the worker (the same pattern as before, relaxed
from every 2 min to every 5 min — `*/5 9-16 * * 1-5` ET) for
`market-quotes`, `movers`, `breadth`, `indices`, `fear-greed`:

```bash
for JOB in market-quotes movers breadth indices fear-greed; do
  gcloud scheduler jobs create http "sync-${JOB}" \
    --project="$PROJECT_ID" --location="$REGION" \
    --schedule="*/5 9-16 * * 1-5" --time-zone="America/New_York" \
    --uri="${SERVICE_URL}/sync/${JOB}/run" --http-method=POST \
    --oidc-service-account-email="$INVOKER_SA" --oidc-token-audience="$SERVICE_URL" \
    --attempt-deadline="900s"
done
```

> ⚠ `deploy/create-scheduler-jobs.sh` is **stale** — it still creates the retired
> single `sync-premarket` HTTP job and points at `/sync/premarket/run`. Use the
> commands above instead until that script is updated.

## 6. First fill (one-time, optional)

There is no universe backfill anymore — the DB starts empty and grows with
usage (on-demand `/live/bars` + `/live/company`) plus the premarket warm. To
prime the cache immediately instead of waiting for tomorrow's premarket run,
execute the Cloud Run Job (2026-08-16 — replaces the retired detached
`POST /sync/premarket/run`, which would be killed on the scale-to-zero worker):

```bash
gcloud run jobs execute premarket-job --region "$REGION" --wait
```

To reset the market-data collections to the on-demand shape (keeps users,
settings, plans, flags): `node deploy/empty-market-data.mjs` (dry run), then
`CONFIRM_DELETE=yes node deploy/empty-market-data.mjs`.

## 7. Verify

```bash
curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token --audiences=$SERVICE_URL)" \
  "$SERVICE_URL/sync/status" | jq .
```
Then confirm docs exist in Firestore (console → the collections in
`Doc/screen-data-sources.md`) and load a UI screen — data should appear with the
UI making **zero** vendor/API calls.

---

## Local development

```bash
cp .env.example .env      # fill in real keys + keep service-account.json for local ADC
npm install
npm run start:dev         # http://localhost:4400  (monitor at /, ops API at /sync/*)
```

## Cost / ops notes
- Add native **TTL policies** for unbounded time-series (`ohlcv_bars` `expireAt` =
  barDate+~400d, `news` = publishedAt+~90d) — see the root README migration notes.
- Cloud Run scale-to-zero means the first Scheduler hit each run does a cold start
  (~a few seconds incl. Firestore's first gRPC channel) — fine for cron cadence.
- **2026-08-16 cost architecture.** Moving the premarket bundle to `premarket-job`
  (~18 min/weekday ≈ $0.50/mo) let the worker service drop `--min-instances=1` +
  `--no-cpu-throttling` for scale-to-zero — total infra bill ~$75–90/mo → <$15/mo.

## 7. Free CDN via Firebase Hosting (2026-07-26)

`firebase.json` (UI repo) rewrites `/live/**` on the Hosting origin to the
`market-catalyst-live` Cloud Run service. Same-origin API calls from the app
therefore ride Firebase Hosting's global CDN for free, cached per the
backend's own `Cache-Control`/`s-maxage` headers — identical polls from many
users collapse to ~1 origin request per interval per edge.

- The UI picks the base automatically (`app/iq/backend.ts`): same-origin on
  `*.web.app` / `*.firebaseapp.com` (→ CDN), the direct Cloud Run URL in dev.
- **SSE stays direct** (`/live/tape/stream` uses the Cloud Run URL) — Hosting
  rewrites buffer/timeout long streams.
- Safe by construction: the rewrite targets the PUBLIC `live` service only
  (LiveModule; no /sync//purge//admin routes exist there), and per-user
  responses (`/live/whoami`) are `no-store` so the CDN never caches them.
- Ships automatically with any `firebase deploy --only hosting`.
