#!/usr/bin/env bash
# Restores everything listed in deploy-rollback.md. Prints the commands by default;
# pass --execute to run them. Uses the signed-in gcloud / firebase accounts; tokens
# are never printed.
set -euo pipefail
P=market-catalyst-502415; R=us-central1
RUN=echo; [[ "${1:-}" == "--execute" ]] && RUN=""
# A real token only when executing; the dry run never fetches or prints one.
tok() { if [[ -z "$RUN" ]]; then gcloud auth print-access-token; else echo "<token>"; fi; }
$RUN gcloud run services update-traffic market-catalyst-backend --to-revisions=market-catalyst-backend-00303-s7c=100 --region $R --project $P
$RUN gcloud run services update-traffic market-catalyst-live --to-revisions=market-catalyst-live-00250-fds=100 --region $R --project $P
$RUN gcloud run jobs update premarket-job --image us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:4242d372816343f5e4536733ee7138f7996cb8c345ae2e1667964a117e424361 --region $R --project $P
$RUN gcloud run jobs update history-backfill-job --image us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:4242d372816343f5e4536733ee7138f7996cb8c345ae2e1667964a117e424361 --region $R --project $P
# Firestore rules: point each release back at its previous ruleset.
for pair in "cloud.firestore:d87ae866-8526-484f-be61-71a0cb1873b2" "cloud.firestore/mc-regional:d87ae866-8526-484f-be61-71a0cb1873b2"; do
  rel=${pair%%:*}; rs=${pair##*:}
  $RUN curl -sf -X PATCH "https://firebaserules.googleapis.com/v1/projects/$P/releases/$rel" \
    -H "Authorization: Bearer $(tok)" -H "x-goog-user-project: $P" -H "content-type: application/json" \
    -d "{\"release\":{\"name\":\"projects/$P/releases/$rel\",\"rulesetName\":\"projects/$P/rulesets/$rs\"}}"
done
# UI Hosting: re-release the previous version.
$RUN curl -sf -X POST "https://firebasehosting.googleapis.com/v1beta1/projects/$P/sites/marketcatalyst/releases?versionName=sites/marketcatalyst/versions/bfd997ceb44f1f28" \
  -H "Authorization: Bearer $(tok)" -H "x-goog-user-project: $P"
