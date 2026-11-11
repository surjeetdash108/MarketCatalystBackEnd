# Deploy rollback values

Captured **before** the staff-checkout-preview deploy on 2026-11-10 (11:30 ET). Restore with
`scripts/rollback.sh` (prints the commands; `--execute` runs them).

| What | Value before this deploy |
|---|---|
| market-catalyst-backend (worker) revision | `market-catalyst-backend-00296-987` |
| market-catalyst-live revision | `market-catalyst-live-00239-g84` |
| Service image (both services) | `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:1bbb904ce118405cef6172abe41615fb61bc2badc2af715f7ad835e498dd240a` |
| premarket-job image | `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:f8b5f1222196ce036bd53f1d8aa3f89518c9b9f68545b4463febb33530cd75e3` |
| history-backfill-job image | `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:f8b5f1222196ce036bd53f1d8aa3f89518c9b9f68545b4463febb33530cd75e3` |
| Firestore rules, (default) database | ruleset `612d55fe-dae3-4242-bc70-e160397016c0` (release `cloud.firestore`) |
| Firestore rules, mc-regional | ruleset `bb613c7d-8a3d-4e96-a487-ae79227efc75` (release `cloud.firestore/mc-regional`) |
| UI Hosting (site `marketcatalyst`) | version `1678375610c23695` (UI commit 4a37aab) |
| Website (App Hosting `marketcatalystwebsite`) | build `build-2026-11-10-002` (Website commit d781451) |

Service env is unchanged by this deploy (code-only roll; ADMIN_REQUIRE_* overrides kept;
BILLING_PROVIDER, SUBSCRIPTIONS_ENABLED and STRIPE_LIVE_APPROVED stay unset; CHECKOUT_PREVIEW
stays off). Firestore rules are not redeployed (unchanged); their current rulesets are listed
for completeness.
