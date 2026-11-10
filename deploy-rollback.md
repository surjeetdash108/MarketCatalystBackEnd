# Deploy rollback values

Captured **before** the go-live-readiness deploy on 2026-11-10 (10:12 ET). Restore with
`scripts/rollback.sh` (prints the commands; `--execute` runs them).

| What | Value before this deploy |
|---|---|
| market-catalyst-backend (worker) revision | `market-catalyst-backend-00296-987` |
| market-catalyst-live revision | `market-catalyst-live-00239-g84` |
| Service image (both services) | `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:1bbb904ce118405cef6172abe41615fb61bc2badc2af715f7ad835e498dd240a` |
| premarket-job image | `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:f8b5f1222196ce036bd53f1d8aa3f89518c9b9f68545b4463febb33530cd75e3` |
| history-backfill-job image | `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:f8b5f1222196ce036bd53f1d8aa3f89518c9b9f68545b4463febb33530cd75e3` |
| Firestore rules, (default) database | ruleset `fdea2777-0db6-440f-bc3c-c251bff8121a` (release `cloud.firestore`) |
| Firestore rules, mc-regional | ruleset `aa3d21d7-7774-4c33-9621-94b5b7dabc62` (release `cloud.firestore/mc-regional`) |
| UI Hosting (site `marketcatalyst`) | version `ed059604ca6d1947` (UI commit 2ee0843) |
| Website (App Hosting `marketcatalystwebsite`) | build `build-2026-11-09-004` (Website commit 0704bc9) |

Service env is unchanged by this deploy (code-only roll; ADMIN_REQUIRE_* overrides kept;
BILLING_PROVIDER and SUBSCRIPTIONS_ENABLED stay unset).
