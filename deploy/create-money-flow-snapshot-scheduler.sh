#!/usr/bin/env bash
#
# Money Flow snapshot: builds the board on the worker and saves it to Firestore
# money_flow/latest (see src/sync/money-flow-snapshot.job.ts), so the live API
# and the browser serve it instantly instead of building while a user waits.
#
# Fires every minute 09:00–16:59 ET on weekdays. Same pattern as the other HTTP
# schedulers (DEPLOY.md §5b/§5c): OIDC POST to /sync/money-flow-snapshot/run on
# the worker. Awaited inline under the per-job lock; a cold first build can take
# a few minutes, hence the 300 s attempt deadline (a tick that lands while a run
# is still going answers "already-running").
#
# Idempotent: creates the scheduler job, or updates it if it already exists.
# Cloud Scheduler is NOT touched by a code deploy — run this script once.
#
# Usage:
#   PROJECT_ID=market-catalyst-502415 REGION=us-central1 \
#   SERVICE_URL=https://market-catalyst-backend-741318166823.us-central1.run.app \
#   INVOKER_SA=<scheduler invoker SA> ./deploy/create-money-flow-snapshot-scheduler.sh

set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION (e.g. us-central1)}"
: "${SERVICE_URL:?set SERVICE_URL (the worker Cloud Run https URL)}"
: "${INVOKER_SA:?set INVOKER_SA (service account email with roles/run.invoker)}"

NAME="sync-money-flow-snapshot"
SCHEDULE="* 9-16 * * 1-5"   # every minute 09:00–16:59 ET weekdays — keep in step with common/job-manifest.ts
TZ_NAME="America/New_York"
URI="${SERVICE_URL%/}/sync/money-flow-snapshot/run"

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
