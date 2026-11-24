#!/usr/bin/env bash
#
# Content pipeline infrastructure (admin console → Content pipeline).
#
#   content-pipeline            topic: "a blog item is waiting" (published by the
#                               live API on submit/retry/send-back, and by the
#                               worker when one run leaves items for the next)
#   content-pipeline-writer     push subscription → worker
#                               POST /sync/content-blog-writer/run (OIDC as the
#                               scheduler invoker, the same identity Cloud
#                               Scheduler uses), 600 s ack deadline, retry with
#                               backoff, then the dead-letter topic
#   content-pipeline-dlq        dead-letter topic (+ a pull subscription to read it)
#   sync-content-blog-writer    Cloud Scheduler safety sweep, every 15 minutes
#
# The queue itself is Firestore content_items: messages only wake the writer,
# so nothing is lost if one is dropped. Acked messages are not retained.
#
# Idempotent. A code deploy does not create any of this — run it once.
#
# Usage:
#   PROJECT_ID=market-catalyst-502415 REGION=us-central1 \
#   WORKER_URL=https://market-catalyst-backend-741318166823.us-central1.run.app \
#   INVOKER_SA=scheduler-invoker@market-catalyst-502415.iam.gserviceaccount.com \
#   PUBLISHER_SAS="741318166823-compute@developer.gserviceaccount.com backend-runtime@market-catalyst-502415.iam.gserviceaccount.com" \
#   ./deploy/create-content-pipeline.sh

set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION}"
: "${WORKER_URL:?set WORKER_URL (the worker Cloud Run https URL)}"
: "${INVOKER_SA:?set INVOKER_SA (service account with roles/run.invoker on the worker)}"
: "${PUBLISHER_SAS:?set PUBLISHER_SAS (space-separated runtime service accounts of the live API and the worker)}"

TOPIC="content-pipeline"
DLQ="content-pipeline-dlq"
SUB="content-pipeline-writer"
DLQ_SUB="content-pipeline-dlq-pull"
JOB="sync-content-blog-writer"
PUSH_URL="${WORKER_URL%/}/sync/content-blog-writer/run"
P="--project=${PROJECT_ID}"

echo "→ enabling the Pub/Sub API"
gcloud services enable pubsub.googleapis.com "$P"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
PUBSUB_AGENT="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

for t in "$TOPIC" "$DLQ"; do
  if gcloud pubsub topics describe "$t" "$P" >/dev/null 2>&1; then
    echo "  topic $t exists"
  else
    echo "→ creating topic $t"
    gcloud pubsub topics create "$t" "$P"
  fi
done

if gcloud pubsub subscriptions describe "$DLQ_SUB" "$P" >/dev/null 2>&1; then
  echo "  subscription $DLQ_SUB exists"
else
  echo "→ creating $DLQ_SUB (to read dead-lettered messages)"
  gcloud pubsub subscriptions create "$DLQ_SUB" --topic="$DLQ" --message-retention-duration=7d "$P"
fi

SUB_FLAGS=(
  --push-endpoint="$PUSH_URL"
  --push-auth-service-account="$INVOKER_SA"
  --push-auth-token-audience="${WORKER_URL%/}"
  --ack-deadline=600
  --min-retry-delay=30s
  --max-retry-delay=600s
  --dead-letter-topic="$DLQ"
  --max-delivery-attempts=5
  --message-retention-duration=1d
)
if gcloud pubsub subscriptions describe "$SUB" "$P" >/dev/null 2>&1; then
  echo "→ updating push subscription $SUB"
  gcloud pubsub subscriptions update "$SUB" "${SUB_FLAGS[@]}" "$P"
else
  echo "→ creating push subscription $SUB → $PUSH_URL"
  gcloud pubsub subscriptions create "$SUB" --topic="$TOPIC" "${SUB_FLAGS[@]}" "$P"
fi

echo "→ letting Pub/Sub dead-letter: publish to $DLQ, subscribe on $SUB"
gcloud pubsub topics add-iam-policy-binding "$DLQ" --member="serviceAccount:${PUBSUB_AGENT}" --role=roles/pubsub.publisher "$P" >/dev/null
gcloud pubsub subscriptions add-iam-policy-binding "$SUB" --member="serviceAccount:${PUBSUB_AGENT}" --role=roles/pubsub.subscriber "$P" >/dev/null
echo "→ letting Pub/Sub mint OIDC tokens for $INVOKER_SA"
gcloud iam service-accounts add-iam-policy-binding "$INVOKER_SA" --member="serviceAccount:${PUBSUB_AGENT}" --role=roles/iam.serviceAccountTokenCreator "$P" >/dev/null

for sa in $PUBLISHER_SAS; do
  echo "→ $sa may publish to $TOPIC"
  gcloud pubsub topics add-iam-policy-binding "$TOPIC" --member="serviceAccount:${sa}" --role=roles/pubsub.publisher "$P" >/dev/null
done

echo "→ scheduler sweep $JOB (every 15 minutes)"
if gcloud scheduler jobs describe "$JOB" "$P" --location="$REGION" >/dev/null 2>&1; then action=update; else action=create; fi
gcloud scheduler jobs "$action" http "$JOB" "$P" \
  --location="$REGION" \
  --schedule="*/15 * * * *" \
  --time-zone="America/New_York" \
  --uri="$PUSH_URL" \
  --http-method=POST \
  --oidc-service-account-email="$INVOKER_SA" \
  --oidc-token-audience="${WORKER_URL%/}" \
  --attempt-deadline=600s

echo "done."
