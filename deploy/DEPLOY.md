# Deploying Market Catalyst Backend to Firebase / GCP (Cloud Run + Cloud Scheduler)

This backend is an **ingestion service**: it pulls from vendor APIs and writes to
Firestore. The frontend reads Firestore directly — it never calls this service.

**Runtime model:** the app is a long-running NestJS server. On Cloud Run we deploy
it **scale-to-zero** and let **Cloud Scheduler** trigger each sync job over HTTP
(`POST /sync/<job>/run`) on its schedule. The in-process `@nestjs/schedule` cron
is therefore **not** the driver in production (a scaled-to-zero instance has no
warm process to fire it) — Cloud Scheduler is. Both use the same schedules, so
behavior is identical; Scheduler just survives scale-to-zero.

Prerequisites: a **Blaze** (pay-as-you-go) Firebase project — Cloud Run, Cloud
Scheduler, and the backfill write-bursts all require it. `gcloud` + `firebase` CLIs
installed and authenticated.

---

## 0. Variables

```bash
export PROJECT_ID=market-catalyst-502415      # MUST match the frontend's Firebase project
export REGION=us-central1
gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com
```

> ⚠ **Project ID must match the frontend.** The backend writes to `$PROJECT_ID`;
> the Next.js app must read from the same project or it sees an empty database.
> Confirm the frontend's `firebaseConfig.projectId` equals `$PROJECT_ID`.

## 1. Deploy Firestore rules + indexes

```bash
firebase deploy --only firestore:rules,firestore:indexes --project "$PROJECT_ID"
```

(If the **frontend** repo already ships `firestore.rules` / `firestore.indexes.json`,
pick ONE repo as the source of truth to avoid overwriting each other.)

## 2. Store vendor API keys in Secret Manager

Never bake keys into the image. Create a secret per key (values from your `.env`):

```bash
for K in POLYGON_API_KEY FMP_API_KEY FINNHUB_API_KEY FRED_API_KEY \
         BENZINGA_API_KEY TRADIER_ACCESS_TOKEN UNUSUAL_WHALES_API_KEY SENTRY_DSN; do
  printf "%s" "PASTE_${K}_VALUE" | gcloud secrets create "$K" --data-file=- 2>/dev/null \
    || printf "%s" "PASTE_${K}_VALUE" | gcloud secrets versions add "$K" --data-file=-
done
```

## 3. Deploy the service to Cloud Run

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
  --set-env-vars="NODE_ENV=production,FIREBASE_PROJECT_ID=${PROJECT_ID},COMPANY_PROFILE_SOURCE=polygon,COMPANY_PROFILE_FALLBACK_SOURCE=fmp,MOVER_ENRICHMENT_SOURCE=polygon,MOVER_ENRICHMENT_FALLBACK_SOURCE=fmp,MOVERS_SOURCE=fmp,MOVERS_FALLBACK_SOURCE=polygon,NEWS_SOURCE=aggregate,SEC_EDGAR_USER_AGENT=Market Catalyst Backend hello@inc108.com" \
  --set-secrets="POLYGON_API_KEY=POLYGON_API_KEY:latest,FMP_API_KEY=FMP_API_KEY:latest,FINNHUB_API_KEY=FINNHUB_API_KEY:latest,FRED_API_KEY=FRED_API_KEY:latest"
```

Notes:
- **No `service-account.json`.** The app uses Application Default Credentials from
  the Cloud Run runtime service account. Grant it Firestore access:
  ```bash
  RUNTIME_SA=$(gcloud run services describe market-catalyst-backend --region "$REGION" --format='value(spec.template.spec.serviceAccountName)')
  # (falls back to the Compute Engine default SA if unset)
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA:-$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')-compute@developer.gserviceaccount.com}" \
    --role="roles/datastore.user"
  ```
- `--no-allow-unauthenticated` keeps `/sync/*` private — only Scheduler (below)
  can invoke it. (The ops monitor at `/` is then also private; reach it via
  `gcloud run services proxy` or make a separate authenticated path if you want it public.)
- `FIREBASE_SERVICE_ACCOUNT_PATH` is intentionally unset → ADC is used.

Grab the URL:
```bash
export SERVICE_URL=$(gcloud run services describe market-catalyst-backend --region "$REGION" --format='value(status.url)')
```

## 4. Create the Scheduler invoker service account

```bash
gcloud iam service-accounts create scheduler-invoker --display-name="Cloud Scheduler → Cloud Run invoker"
export INVOKER_SA="scheduler-invoker@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud run services add-iam-policy-binding market-catalyst-backend \
  --region "$REGION" --member="serviceAccount:${INVOKER_SA}" --role="roles/run.invoker"
```

## 5. Create the 21 scheduler jobs

```bash
PROJECT_ID="$PROJECT_ID" REGION="$REGION" SERVICE_URL="$SERVICE_URL" INVOKER_SA="$INVOKER_SA" \
  ./deploy/create-scheduler-jobs.sh
```

## 6. First backfill (one-time)

The schedules only fire going forward. To populate Firestore now, trigger jobs
manually (order matters for a couple):

```bash
TOKEN=$(gcloud auth print-identity-token --audiences="$SERVICE_URL")
for JOB in ticker-universe companies sectors market-indices market-quotes \
           market-movers earnings analyst-actions news dividends ipos \
           macro-events options-chains fear-greed sec-13f sec-form4; do
  echo "== $JOB =="; curl -s -X POST -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/sync/$JOB/run" | head -c 200; echo
done
# stock-history is a rotating batch — run ~4x to cover the universe, THEN rs-rating/tech-rating/technical-indicators.
```

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
npm run start:dev         # http://localhost:4100  (monitor at /, ops API at /sync/*)
```

## Cost / ops notes
- Add native **TTL policies** for unbounded time-series (`ohlcv_bars` `expireAt` =
  barDate+~400d, `news` = publishedAt+~90d) — see the root README migration notes.
- Cloud Run scale-to-zero means the first Scheduler hit each run does a cold start
  (~a few seconds incl. Firestore's first gRPC channel) — fine for cron cadence.
