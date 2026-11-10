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
for pair in "cloud.firestore:612d55fe-dae3-4242-bc70-e160397016c0" "cloud.firestore/mc-regional:bb613c7d-8a3d-4e96-a487-ae79227efc75"; do
  rel=${pair%%:*}; rs=${pair##*:}
  $RUN curl -sf -X PATCH "https://firebaserules.googleapis.com/v1/projects/$P/releases/$rel" \
    -H "Authorization: Bearer $(tok)" -H "x-goog-user-project: $P" -H "content-type: application/json" \
    -d "{\"release\":{\"name\":\"projects/$P/releases/$rel\",\"rulesetName\":\"projects/$P/rulesets/$rs\"}}"
done
# UI Hosting: re-release the previous version.
$RUN curl -sf -X POST "https://firebasehosting.googleapis.com/v1beta1/projects/$P/sites/marketcatalyst/releases?versionName=sites/marketcatalyst/versions/1678375610c23695" \
  -H "Authorization: Bearer $(tok)" -H "x-goog-user-project: $P"
# Website (App Hosting): roll out the previous build.
$RUN curl -sf -X POST "https://firebaseapphosting.googleapis.com/v1/projects/$P/locations/us-east4/backends/marketcatalystwebsite/rollouts?rolloutId=rollback-$(date +%s)" \
  -H "Authorization: Bearer $(tok)" -H "x-goog-user-project: $P" -H "content-type: application/json" \
  -d "{\"build\":\"projects/$P/locations/us-east4/backends/marketcatalystwebsite/builds/build-2026-11-10-002\"}"
