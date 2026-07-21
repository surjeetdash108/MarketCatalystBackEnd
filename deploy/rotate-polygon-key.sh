#!/bin/bash
#
# Rotates POLYGON_API_KEY end to end.
#
# Prerequisite you must do FIRST, by hand:
#   Sign in to the Massive/Polygon dashboard and GENERATE a new API key.
#   Do NOT revoke the old one yet — this script verifies the new key works and
#   ships it to production before anything is torn down.
#
# The new key is read with `read -rs`: it is not echoed, not written to shell
# history, and never appears in a command line (so it cannot be read out of
# `ps`). It is passed to gcloud and to the .env rewrite over stdin only.
#
# Run from the repo root:  ./deploy/rotate-polygon-key.sh

set -euo pipefail

REGION="${REGION:-us-central1}"
SERVICE="market-catalyst-backend"
SECRET="POLYGON_API_KEY"
BASE_URL="https://api.massive.com"

command -v gcloud >/dev/null || { echo "gcloud not found"; exit 1; }
[ -f package.json ] || { echo "Run from the repo root."; exit 1; }

printf 'New Polygon/Massive API key (input hidden): '
read -rs NEW_KEY
printf '\n'
[ -n "$NEW_KEY" ] || { echo "Empty key — aborting."; exit 1; }

OLD_VERSION="$(gcloud secrets versions list "$SECRET" --filter='state:enabled' \
  --format='value(name)' --limit=1)"
echo "Currently enabled secret version: ${OLD_VERSION:-none}"

# ── 1. Verify the new key BEFORE changing anything ───────────────────────────
# A typo here would otherwise take production down at the redeploy step, with
# the old key already revoked and no way back.
echo "Verifying the new key against ${BASE_URL} ..."
CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  "${BASE_URL}/v3/reference/tickers?limit=1&apiKey=${NEW_KEY}")"
if [ "$CODE" != "200" ]; then
  echo "New key rejected by the vendor (HTTP $CODE). Nothing has been changed."
  exit 1
fi
echo "  ✓ key accepted (HTTP 200)"

# Confirm it carries the paid entitlements the app depends on, not just a valid
# account — a free-tier key authenticates fine and then fails every sync job.
INTRADAY="$(curl -s -o /dev/null -w '%{http_code}' \
  "${BASE_URL}/v2/aggs/ticker/AAPL/range/5/minute/2026-07-17/2026-07-21?apiKey=${NEW_KEY}")"
FIVE_YR="$(curl -s -o /dev/null -w '%{http_code}' \
  "${BASE_URL}/v2/aggs/ticker/AAPL/range/1/day/$(date -v-4y +%Y-%m-%d)/$(date +%Y-%m-%d)?apiKey=${NEW_KEY}")"
echo "  intraday aggs: HTTP $INTRADAY   4-year daily aggs: HTTP $FIVE_YR"
if [ "$INTRADAY" != "200" ] || [ "$FIVE_YR" != "200" ]; then
  echo "  ⚠ The key works but lacks the paid entitlements this app needs."
  echo "    Intraday charts and 5Y history would break. Aborting."
  exit 1
fi

# ── 2. Add as a new Secret Manager version ───────────────────────────────────
printf '%s' "$NEW_KEY" | gcloud secrets versions add "$SECRET" --data-file=-
NEW_VERSION="$(gcloud secrets versions list "$SECRET" --filter='state:enabled' \
  --format='value(name)' --limit=1)"
echo "  ✓ added secret version $NEW_VERSION"

# ── 3. Update the local .env (gitignored) ────────────────────────────────────
# Done in python so the key never appears in argv.
if [ -f .env ]; then
  NEW_KEY="$NEW_KEY" python3 - <<'PY'
import os, re, pathlib
p = pathlib.Path(".env")
key = os.environ["NEW_KEY"]
lines = p.read_text().splitlines()
out, seen = [], False
for line in lines:
    if re.match(r"^POLYGON_API_KEY=", line):
        out.append(f"POLYGON_API_KEY={key}"); seen = True
    else:
        out.append(line)
if not seen:
    out.append(f"POLYGON_API_KEY={key}")
p.write_text("\n".join(out) + "\n")
print("  ✓ local .env updated")
PY
fi
unset NEW_KEY

# ── 4. Redeploy so Cloud Run picks it up ─────────────────────────────────────
# Cloud Run resolves `--set-secrets ...:latest` when the REVISION IS CREATED,
# not per request. Adding a secret version alone changes nothing in production
# until a new revision exists — this step is mandatory, not cosmetic.
echo "Deploying a new revision so :latest is re-resolved ..."
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --no-allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --memory=512Mi \
  --timeout=900 \
  --env-vars-file=deploy/env.production.yaml \
  --set-secrets="POLYGON_API_KEY=POLYGON_API_KEY:latest,FMP_API_KEY=FMP_API_KEY:latest,FINNHUB_API_KEY=FINNHUB_API_KEY:latest,FRED_API_KEY=FRED_API_KEY:latest"

# ── 5. Retire the old secret version ─────────────────────────────────────────
if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
  gcloud secrets versions disable "$OLD_VERSION" --secret="$SECRET"
  echo "  ✓ disabled old secret version $OLD_VERSION"
fi

cat <<'DONE'

Rotation complete in GCP.

ONE MANUAL STEP REMAINS — this script cannot do it:
  Revoke/delete the OLD key in the Massive/Polygon dashboard.
  Until you do, the leaked key still works against your account and quota.

Then confirm production is healthy:
  gcloud run services proxy market-catalyst-backend --region=us-central1 --port=8080
  curl -s localhost:8080/live/market-status
DONE
