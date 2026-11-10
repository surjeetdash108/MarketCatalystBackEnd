#!/usr/bin/env bash
#
# 3x Daily Analyst Actions sweep (8 AM CST, 12 PM CST, 4 PM CST).
#
# Covers morning pre-market notes (8 AM CST / 9 AM ET), mid-day updates
# (12 PM CST / 1 PM ET), and post-close final revisions (4 PM CST / 5 PM ET).
#
# Same pattern as the intraday HTTP schedulers (DEPLOY.md §5b): OIDC POST to
# /sync/analyst-actions/run on the worker. The job is awaited inline (not in
# SyncController.DETACHED_JOBS) and takes ~4 min for ~900 tickers, well inside
# Cloud Run's 900s request timeout.
#
# Idempotent: creates the scheduler job, or updates it if it already exists.
#
# Usage:
#   PROJECT_ID=market-catalyst-502415 \
#   REGION=us-central1 \
#   SERVICE_URL=https://market-catalyst-backend-xxxxx-uc.a.run.app \
#   INVOKER_SA=scheduler-invoker@market-catalyst-502415.iam.gserviceaccount.com \
#   ./deploy/create-analyst-close-scheduler.sh
#
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION (e.g. us-central1)}"
: "${SERVICE_URL:?set SERVICE_URL (the worker Cloud Run https URL)}"
: "${INVOKER_SA:?set INVOKER_SA (service account email with roles/run.invoker)}"

NAME="sync-analyst-actions"
SCHEDULE="0 8,12,16 * * 1-5"   # 8 AM CST, 12 PM CST, 4 PM CST weekdays
TZ_NAME="America/Chicago"
URI="${SERVICE_URL%/}/sync/analyst-actions/run"

echo "→ ${NAME}  ('${SCHEDULE}' ${TZ_NAME})  ${URI}"

if gcloud scheduler jobs describe "${NAME}" \
      --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1; then
  action=update
else
  action=create
fi

gcloud scheduler jobs "${action}" http "${NAME}" \
  --project="${PROJECT_ID}" \
  --location="${REGION}" \
  --schedule="${SCHEDULE}" \
  --time-zone="${TZ_NAME}" \
  --uri="${URI}" \
  --http-method=POST \
  --oidc-service-account-email="${INVOKER_SA}" \
  --oidc-token-audience="${SERVICE_URL%/}" \
  --attempt-deadline="900s"

# Clean up legacy single after-close job if it existed
if gcloud scheduler jobs describe "sync-analyst-actions-close" \
      --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud scheduler jobs delete "sync-analyst-actions-close" \
    --project="${PROJECT_ID}" --location="${REGION}" --quiet >/dev/null 2>&1 || true
fi

echo "✔ ${NAME} ${action}d. Fire it once now to verify:"
echo "  gcloud scheduler jobs run ${NAME} --project=${PROJECT_ID} --location=${REGION}"
