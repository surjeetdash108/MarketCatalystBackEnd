# Deploy rollback values

Captured **before** the 2026-11-12 16:10 ET deploy (backend + jobs + UI from prod
59239d9 / UI prod 8d42262). Restore with `scripts/rollback.sh` (prints the
commands; `--execute` runs them; tokens are never printed).

| What | Value before this deploy |
|---|---|
| market-catalyst-backend (worker) revision | `market-catalyst-backend-00303-s7c` (image `…/market-catalyst-live@sha256:c8a5d3b457b92553a0cb6ddf6a1a68204c6cf124af3a3f7f473000b051a60ac2`) |
| market-catalyst-live revision | `market-catalyst-live-00251-rg5` (image `…/market-catalyst-live@sha256:a0066b754f5ef33e6d6245e610ad610404804fd7661fe66e78b9e88293b17f05`). **Never roll back to 00250-fds**: it had APP_ROLE=worker + ADMIN_GUARD_TRUST_IAM=true on the public service, which opened every admin endpoint to the internet (fixed 2026-11-12 ~14:15 ET). |
| premarket-job image | `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:4242d372816343f5e4536733ee7138f7996cb8c345ae2e1667964a117e424361` |
| history-backfill-job image | same as premarket-job |
| Firestore rules, (default) and mc-regional | ruleset `d87ae866-8526-484f-be61-71a0cb1873b2` (both releases) |
| UI Hosting (site `marketcatalyst`) | version `bfd997ceb44f1f28` |

Service env is not changed by this deploy (code only). Production env at capture
time: live API has BILLING_PROVIDER=stripe, SUBSCRIPTIONS_ENABLED=true, Stripe
secrets from Secret Manager; worker has BILLING_PROVIDER=stripe.
