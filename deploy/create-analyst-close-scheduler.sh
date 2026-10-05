#!/usr/bin/env bash
#
# After-close analyst-actions sweep (2026-10-05).
#
# The 08:00 ET premarket run only sees rating changes FMP has indexed by then —
# on 2026-10-02 that was 5 of the day's 78 — so a day's upgrades/downgrades did
# not reach the Analyst Actions screen until the NEXT weekday morning (Friday's
# on Monday). This second run at 18:30 ET picks up the whole session's changes
# the same evening. The premarket run stays: it refreshes consensus / price
# targets before the open and catches overnight notes.
#
# Same pattern as the intraday HTTP schedulers (DEPLOY.md §5b): OIDC POST to
# /sync/analyst-actions/run on the worker. The job is awaited inline (not in
# SyncController.DETACHED_JOBS) and takes ~4 min for ~900 tickers, well inside
# Cloud Run's 900s request timeout.
#
# Cost: one more full-universe FMP sweep per weekday (~3 calls per ticker:
# grades-consensus, price-target, grades). FMP_API_KEY is shared with every
# other FMP caller — if the plan's request limit is hit, the job records
# ok:false in sync_meta once >25% of tickers fail.
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

NAME="sync-analyst-actions-close"
SCHEDULE="30 18 * * 1-5"   # 18:30 ET weekdays — after the close
TZ_NAME="America/New_York"
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

echo "✔ ${NAME} ${action}d. Fire it once now to verify:"
echo "  gcloud scheduler jobs run ${NAME} --project=${PROJECT_ID} --location=${REGION}"
