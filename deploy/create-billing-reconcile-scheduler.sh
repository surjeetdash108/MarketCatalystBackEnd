#!/usr/bin/env bash
#
# Nightly billing mirror repair (billing-reconcile).
#
# Fires at 03:30 America/New_York and re-syncs subscriptions/{uid} from Stripe
# wherever they drifted (see src/billing/reconcile.job.ts). Same pattern as
# the other HTTP schedulers (DEPLOY.md §5b/§5c): OIDC POST to
# /sync/billing-reconcile/run on the worker. It lists the provider's
# subscriptions once and writes only the drifted mirrors.
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
#   ./deploy/create-billing-reconcile-scheduler.sh
#
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION (e.g. us-central1)}"
: "${SERVICE_URL:?set SERVICE_URL (the worker Cloud Run https URL)}"
: "${INVOKER_SA:?set INVOKER_SA (service account email with roles/run.invoker)}"

NAME="sync-billing-reconcile"
SCHEDULE="30 3 * * *"     # 03:30 ET nightly — keep in step with common/job-manifest.ts
TZ_NAME="America/New_York"
URI="${SERVICE_URL%/}/sync/billing-reconcile/run"

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

echo "✔ ${NAME} ${action}d. Fire it once now to verify :"
echo "  gcloud scheduler jobs run ${NAME} --project=${PROJECT_ID} --location=${REGION}"
