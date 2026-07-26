#!/usr/bin/env bash
#
# ONE Cloud Scheduler job (2026-07-24 on-demand redesign): everything periodic
# runs inside a single premarket window via /sync/premarket/run, which
# orchestrates warm-cache + market-wide + per-ticker + recap phases in
# dependency order (see src/sync/premarket.job.ts). The 22 scattered per-job
# schedules are RETIRED — this script also deletes them.
#
# Intraday freshness does not come from batch syncs: it comes from the live
# layer (/live/tape SSE, /live/snapshot, and the on-demand /live/bars TTLs).
#
# Prereqs:
#   - Cloud Run worker service deployed (see DEPLOY.md); note its URL.
#   - INVOKER_SA has roles/run.invoker on that service.
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
# The orchestrator runs many jobs sequentially — give it the Scheduler maximum.
DEADLINE="1800s"

NAME="sync-premarket"
SCHEDULE="0 8 * * 1-5"   # 08:00 ET weekdays — premarket, before the open
URI="${SERVICE_URL}/sync/premarket/run"

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
  --oidc-token-audience="${SERVICE_URL}" \
  --attempt-deadline="${DEADLINE}"

# ── Retire the old per-job schedules ─────────────────────────────────────────
OLD_JOBS=(
  sec-13f sec-form4 companies stock-history ticker-universe rs-rating
  technical-indicators tech-rating fundamentals-growth analyst-actions
  earnings ipos dividends news market-indices market-quotes sectors
  market-movers macro-events fear-greed recaps options-chains
)
for job in "${OLD_JOBS[@]}"; do
  name="sync-${job}"
  if gcloud scheduler jobs describe "${name}" \
        --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1; then
    echo "✂ deleting retired scheduler job ${name}"
    gcloud scheduler jobs delete "${name}" --quiet \
      --project="${PROJECT_ID}" --location="${REGION}"
  fi
done

echo "✔ Single premarket scheduler job in place; retired jobs removed."
