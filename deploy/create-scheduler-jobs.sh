#!/usr/bin/env bash
#
# Creates (or updates) one Cloud Scheduler job per sync job, each POSTing to the
# Cloud Run service's /sync/<job>/run endpoint on the same schedule the code's
# @Cron decorators declare. Schedules are mirrored verbatim from src/sync/*.job.ts.
#
# Prereqs:
#   - Cloud Run service already deployed (see DEPLOY.md); note its URL.
#   - A service account Scheduler uses to authenticate to the (private) Cloud Run
#     service, with roles/run.invoker on that service.
#
# Usage:
#   PROJECT_ID=market-catalyst-502415 \
#   REGION=us-central1 \
#   SERVICE_URL=https://market-catalyst-backend-xxxxx-uc.a.run.app \
#   INVOKER_SA=scheduler-invoker@market-catalyst-502415.iam.gserviceaccount.com \
#   ./deploy/create-scheduler-jobs.sh
#
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION (e.g. us-central1)}"
: "${SERVICE_URL:?set SERVICE_URL (the Cloud Run https URL)}"
: "${INVOKER_SA:?set INVOKER_SA (service account email with roles/run.invoker)}"

TZ_NAME="America/New_York"
DEADLINE="900s"   # < Cloud Scheduler's 30-min max; each job is bounded/batched

# job-name | cron schedule  (verbatim from the @Cron decorators)
JOBS=(
  "sec-13f|0 1 * * *"
  "sec-form4|30 1 * * *"
  "companies|0 2 * * *"
  "stock-history|0 3 * * *"
  "ticker-universe|0 3 * * 0"
  "rs-rating|0 4 * * *"
  "technical-indicators|10 4 * * *"
  "tech-rating|15 4 * * *"
  "fundamentals-growth|30 4 * * *"
  "analyst-actions|0 6 * * *"
  "earnings|0 6 * * *"
  "ipos|15 6 * * *"
  "dividends|20 6 * * *"
  "news|*/30 9-16 * * 1-5"
  "market-indices|5 18 * * 1-5"
  "market-quotes|7 18 * * 1-5"
  "sectors|0 18 * * 1-5"
  "market-movers|0 18 * * 1-5"
  "macro-events|10 18 * * 1-5"
  "fear-greed|15 18 * * 1-5"
  "options-chains|0 19 * * 1-5"
)

for entry in "${JOBS[@]}"; do
  job="${entry%%|*}"
  schedule="${entry##*|}"
  name="sync-${job}"
  uri="${SERVICE_URL}/sync/${job}/run"

  echo "→ ${name}  ('${schedule}' ${TZ_NAME})  ${uri}"

  if gcloud scheduler jobs describe "${name}" \
        --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1; then
    action=update
  else
    action=create
  fi

  gcloud scheduler jobs "${action}" http "${name}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --schedule="${schedule}" \
    --time-zone="${TZ_NAME}" \
    --uri="${uri}" \
    --http-method=POST \
    --oidc-service-account-email="${INVOKER_SA}" \
    --oidc-token-audience="${SERVICE_URL}" \
    --attempt-deadline="${DEADLINE}"
done

echo "✔ All 21 scheduler jobs created/updated."
