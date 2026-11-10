#!/usr/bin/env bash
# Restores everything listed in deploy-rollback.md. Prints the commands by default;
# pass --execute to run them. Uses the signed-in gcloud / firebase accounts; tokens
# are never printed.
set -euo pipefail
P=market-catalyst-502415; R=us-central1
RUN=echo; [[ "${1:-}" == "--execute" ]] && RUN=""
# A real token only when executing; the dry run never fetches or prints one.
tok() { if [[ -z "$RUN" ]]; then gcloud auth print-access-token; else echo "<token>"; fi; }
$RUN gcloud run services update-traffic market-catalyst-backend --to-revisions=market-catalyst-backend-00296-987=100 --region $R --project $P
$RUN gcloud run services update-traffic market-catalyst-live --to-revisions=market-catalyst-live-00239-g84=100 --region $R --project $P
$RUN gcloud run jobs update premarket-job --image us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:f8b5f1222196ce036bd53f1d8aa3f89518c9b9f68545b4463febb33530cd75e3 --region $R --project $P
$RUN gcloud run jobs update history-backfill-job --image us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:f8b5f1222196ce036bd53f1d8aa3f89518c9b9f68545b4463febb33530cd75e3 --region $R --project $P
# Firestore rules: point each release back at its previous ruleset.
for pair in "cloud.firestore:fdea2777-0db6-440f-bc3c-c251bff8121a" "cloud.firestore/mc-regional:aa3d21d7-7774-4c33-9621-94b5b7dabc62"; do
  rel=${pair%%:*}; rs=${pair##*:}
  $RUN curl -sf -X PATCH "https://firebaserules.googleapis.com/v1/projects/$P/releases/$rel" \
    -H "Authorization: Bearer $(tok)" -H "x-goog-user-project: $P" -H "content-type: application/json" \
    -d "{\"release\":{\"name\":\"projects/$P/releases/$rel\",\"rulesetName\":\"projects/$P/rulesets/$rs\"}}"
done
# UI Hosting: re-release the previous version.
$RUN curl -sf -X POST "https://firebasehosting.googleapis.com/v1beta1/projects/$P/sites/marketcatalyst/releases?versionName=sites/marketcatalyst/versions/ed059604ca6d1947" \
  -H "Authorization: Bearer $(tok)" -H "x-goog-user-project: $P"
# Website (App Hosting): roll out the previous build.
$RUN curl -sf -X POST "https://firebaseapphosting.googleapis.com/v1/projects/$P/locations/us-east4/backends/marketcatalystwebsite/rollouts?rolloutId=rollback-$(date +%s)" \
  -H "Authorization: Bearer $(tok)" -H "x-goog-user-project: $P" -H "content-type: application/json" \
  -d '{"build":"projects//locations/us-east4/backends/marketcatalystwebsite/builds/build-2026-11-09-004"}'
