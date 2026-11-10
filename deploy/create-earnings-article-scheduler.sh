#!/usr/bin/env bash
# Earnings articles (src/sync/earnings-article.job.ts).
#
# Two Cloud Scheduler entries POST /sync/earnings-article/run on the worker:
#   sync-earnings-article           every minute, 6:00–19:59 ET weekdays (both reporting windows)
#   sync-earnings-article-offhours  every 15 minutes the rest of each weekday
# Each pass reads FMP's earnings calendar and publishes one article per newly
# reported $1B+ US company. A pass with nothing new costs two FMP calls and two
# Firestore reads. Keep the schedules in step with common/job-manifest.ts.
#
# The very first pass only records what has already reported (the baseline)
# and posts nothing; posting starts with the next report.
#
# Usage:
#   PROJECT_ID=… REGION=us-central1 SERVICE_URL=https://… INVOKER_SA=…@….iam.gserviceaccount.com \
#   ./deploy/create-earnings-article-scheduler.sh
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION (e.g. us-central1)}"
: "${SERVICE_URL:?set SERVICE_URL (the worker Cloud Run https URL)}"
: "${INVOKER_SA:?set INVOKER_SA (service account email with roles/run.invoker)}"

TZ_NAME="America/New_York"
URI="${SERVICE_URL%/}/sync/earnings-article/run"

upsert() {
  local name="$1" schedule="$2"
  echo "→ ${name}  ('${schedule}' ${TZ_NAME})  ${URI}"
  local action=create
  if gcloud scheduler jobs describe "${name}" --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1; then
    action=update
  fi
  gcloud scheduler jobs "${action}" http "${name}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --schedule="${schedule}" \
    --time-zone="${TZ_NAME}" \
    --uri="${URI}" \
    --http-method=POST \
    --oidc-service-account-email="${INVOKER_SA}" \
    --oidc-token-audience="${SERVICE_URL%/}" \
    --attempt-deadline="300s"
  echo "✔ ${name} ${action}d."
}

upsert sync-earnings-article "* 6-19 * * 1-5"
upsert sync-earnings-article-offhours "*/15 0-5,20-23 * * 1-5"

echo "Fire one pass now to verify:"
echo "  gcloud scheduler jobs run sync-earnings-article --project=${PROJECT_ID} --location=${REGION}"
