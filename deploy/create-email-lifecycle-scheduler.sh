#!/usr/bin/env bash
#
# Hourly email lifecycle sweep (src/email/email-lifecycle.service.ts): Welcome /
# Trial started catch-up for Google sign-ups, Getting started and First
# activation on day 2, Trial ending 3 days before and Trial ended on the day.
# OIDC POST to /sync/email-lifecycle/run on the worker, same pattern as the
# other HTTP schedulers. Idempotent: creates the job, or updates it.
# Cloud Scheduler is NOT touched by a code deploy - run this script.
#
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION (e.g. us-central1)}"
: "${SERVICE_URL:?set SERVICE_URL (the worker Cloud Run https URL)}"
: "${INVOKER_SA:?set INVOKER_SA (service account email with roles/run.invoker)}"

NAME="sync-email-lifecycle"
SCHEDULE="15 * * * *"   # hourly at :15 — keep in step with common/job-manifest.ts
TZ_NAME="America/New_York"
URI="${SERVICE_URL%/}/sync/email-lifecycle/run"

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
  --attempt-deadline="600s"

echo "✔ ${NAME} ${action}d. Fire it once now to verify :"
echo "  gcloud scheduler jobs run ${NAME} --project=${PROJECT_ID} --location=${REGION}"
