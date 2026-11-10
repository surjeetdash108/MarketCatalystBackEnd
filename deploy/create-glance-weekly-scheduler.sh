#!/usr/bin/env bash
#
# Friday-noon "Week at a glance" (Live Feed > Weekly Summary).
#
# Fires every Friday 12:00 America/New_York and builds + stores the current
# week's market digest, so the summary exists before the first viewer opens the
# tab. Same pattern as the other HTTP schedulers (DEPLOY.md §5b/§5c): OIDC POST
# to /sync/market-glance-weekly/run on the worker. The job is awaited inline
# (not in SyncController.DETACHED_JOBS); one digest is a single bounded LLM call
# (<~45s worst case across two providers), far inside the attempt deadline.
#
# Idempotent: creates the scheduler job, or updates it if it already exists.
# Cloud Scheduler is NOT touched by a code deploy — this script (or the
# equivalent gcloud command) must be run once against the project.
#
# Usage:
#   PROJECT_ID=market-catalyst-502415 \
#   REGION=us-central1 \
#   SERVICE_URL=https://market-catalyst-backend-xxxxx-uc.a.run.app \
#   INVOKER_SA=scheduler-invoker@market-catalyst-502415.iam.gserviceaccount.com \
#   ./deploy/create-glance-weekly-scheduler.sh
#
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION (e.g. us-central1)}"
: "${SERVICE_URL:?set SERVICE_URL (the worker Cloud Run https URL)}"
: "${INVOKER_SA:?set INVOKER_SA (service account email with roles/run.invoker)}"

NAME="sync-market-glance-weekly"
SCHEDULE="0 12 * * 5"   # Fridays 12:00 ET — keep in step with common/job-manifest.ts
TZ_NAME="America/New_York"
URI="${SERVICE_URL%/}/sync/market-glance-weekly/run"

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
  --attempt-deadline="300s"

echo "✔ ${NAME} ${action}d. Fire it once now to verify:"
echo "  gcloud scheduler jobs run ${NAME} --project=${PROJECT_ID} --location=${REGION}"
