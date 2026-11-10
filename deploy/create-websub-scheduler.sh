#!/usr/bin/env bash
#
# WebSub ping for the public RSS feed (https://marketcatalyst.ai/feed.xml).
#
# Fires every 10 minutes, all week, and tells the WebSub hub when a post has
# gone live since the last run (see src/sync/websub-ping.job.ts). Same pattern as
# the other HTTP schedulers (DEPLOY.md §5b/§5c): OIDC POST to
# /sync/websub-ping/run on the worker. The job is awaited inline: one indexed
# Firestore query and at most one 15-second HTTP call.
#
# Idempotent: creates the scheduler job, or updates it if it already exists.
# Cloud Scheduler is NOT touched by a code deploy — this script (or the
# equivalent gcloud command) must be run once against the project, AFTER the
# worker revision that contains the job is live (until then the POST is a 404).
#
# Usage:
#   PROJECT_ID=market-catalyst-502415 \
#   REGION=us-central1 \
#   SERVICE_URL=https://market-catalyst-backend-xxxxx-uc.a.run.app \
#   INVOKER_SA=scheduler-invoker@market-catalyst-502415.iam.gserviceaccount.com \
#   ./deploy/create-websub-scheduler.sh
#
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION (e.g. us-central1)}"
: "${SERVICE_URL:?set SERVICE_URL (the worker Cloud Run https URL)}"
: "${INVOKER_SA:?set INVOKER_SA (service account email with roles/run.invoker)}"

NAME="sync-websub-ping"
SCHEDULE="*/10 * * * *"   # every 10 minutes — keep in step with common/job-manifest.ts
TZ_NAME="America/New_York"
URI="${SERVICE_URL%/}/sync/websub-ping/run"

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
  --attempt-deadline="120s"

echo "✔ ${NAME} ${action}d. Fire it once now to verify (the first run only sets the baseline):"
echo "  gcloud scheduler jobs run ${NAME} --project=${PROJECT_ID} --location=${REGION}"
