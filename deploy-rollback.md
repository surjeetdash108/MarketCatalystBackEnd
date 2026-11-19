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

## 2026-11-13 16:02 ET — payments fixes deploy (rollback values captured before)
- backend worker: `market-catalyst-backend-00304-mr8`
- live API: `market-catalyst-live-00252-zc5`
- jobs image: `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:1da195e8bf5249fbba0fb16ceda3b891d77c8677654a5285047af59787807436`
- UI hosting version: `c4bf923508805367` (logout fix)
- Website build: `build-2026-11-12-001` (b0a3af7)
- Firestore rules: `d87ae866-8526-484f-be61-71a0cb1873b2` (unchanged by this deploy)

## 2026-11-13 — Lifetime Elite → staff deploy (rollback values captured before)
- backend worker: `market-catalyst-backend-00305-kc6`
- live API: `market-catalyst-live-00253-ldx`
- jobs image: `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:f5caa19be18bcde0321a5ba332124b69de4829e5b87a17af6baf259377435c0d`
- UI hosting version: `c986e35056103a26`
- Staff list now 15 emails (the 13 former Lifetime Elite + sanjay.halle@inc108.com); to undo, roll back code first, the staff entries are harmless.

## 2026-11-13 — owner list deploy (rollback values captured before)
- backend worker: `market-catalyst-backend-00306-p28`
- live API: `market-catalyst-live-00254-2l5`
- jobs image: `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:87e1ce0dea1dde4ca8994994a6fbc5df449c3d3c35d7892a80390bfc42032ae9`
- UI hosting version: `01a34dac7cb0219f`

## 2026-11-18 — Alpha Signals module deploy (rollback values captured before)
- backend worker: `market-catalyst-backend-00316-49x`
- live API: `market-catalyst-live-00265-mng`
- UI hosting version: `5077cc98f37c1893`
- Website build: `build-2026-11-17-001`
- Code only (no env, rules or catalog-doc changes). Jobs not redeployed: the change is entitlements only.

## 2026-11-18 — Market Catalyst Pulse + toggle order deploy (rollback values captured before)
- backend worker: `market-catalyst-backend-00318-c4c`
- live API: `market-catalyst-live-00267-nzz`
- UI hosting version: `a772b5f6eb40c972`
- New Firestore collection `pulse_posts` (admin posts); safe to leave in place on rollback.

## 2026-11-18 — admin ticker search for the Pulse picker (rollback values captured before)
- backend worker: `market-catalyst-backend-00319-mth`
- live API: `market-catalyst-live-00268-769`
- UI hosting version: `27f2926caf866521`

## 2026-11-19 — deploy latest prod (backend 84e7f57, UI e5d19a1) (rollback values captured before)
- backend worker: `market-catalyst-backend-00320-cl9`
- live API: `market-catalyst-live-00270-fvq`
- UI hosting version (site marketcatalyst): `edd87e721b27958b` (new: `3f2e31b7f7ab4c2d`)

## 2026-11-19 — trial window, Alpha Signals workbook fixes, RS rating, Pulse search, index members (rollback values captured before)
- backend worker: `market-catalyst-backend-00321-tm9`
- live API: `market-catalyst-live-00271-wmq`
- UI hosting version (site marketcatalyst): `1abde182ccb0c755`

## 2026-11-19 — feedback store + admin Feedback, upgrade success copy (rollback values captured before)
- backend worker: `market-catalyst-backend-00323-2mb`
- live API: `market-catalyst-live-00273-k8w`
- UI hosting version (site marketcatalyst): `adbc3121570f08cf`

## 2026-11-19 — Nov 19 workbook fixes, quote check, Polygon-first intraday, job images (rollback values captured before)
- backend worker: ``
- live API: ``
- premarket-job image: ``
- history-backfill-job image: ``
- UI hosting version (site marketcatalyst): `d86d578badf478b7`
