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
- backend worker: `market-catalyst-backend-00324-n9g`
- live API: `market-catalyst-live-00274-x6f`
- premarket-job image: `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:0963c79a490699f118fc047a80175938c109e6f59a926532c3446dfbb8f4f73e`
- history-backfill-job image: `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:0963c79a490699f118fc047a80175938c109e6f59a926532c3446dfbb8f4f73e`
- UI hosting version (site marketcatalyst): `d86d578badf478b7`

## 2026-11-20 — branded emails (SendGrid, placeholder key), verification code, lifecycle emails + Nov 19 workbook release (rollback values captured before)
- backend worker: `market-catalyst-backend-00324-n9g`
- live API: `market-catalyst-live-00274-x6f`
- premarket-job / history-backfill-job image: `…market-catalyst-backend@sha256:0963c79a490699f118fc047a80175938c109e6f59a926532c3446dfbb8f4f73e`
- UI hosting version (site marketcatalyst): `d86d578badf478b7`
- env added on both services: EMAIL_PROVIDER, EMAIL_PROVIDER_API_KEY (placeholder), EMAIL_FROM_ADDRESS, EMAIL_REPLY_TO, OTP_TEST_CODE_ENABLED, EMAIL_LINK_SECRET (Secret Manager); new Cloud Scheduler job sync-email-lifecycle. To undo: remove those env vars, delete the scheduler job.

## 2026-11-20 15:16 ET — Firestore rules lockdown + browser key restriction (rollback values captured before)
- Firestore rules, (default) and mc-regional: previous ruleset `d87ae866-8526-484f-be61-71a0cb1873b2` (both). New: `1bc2bde8-a2f8-46ee-ad62-3733060ef654` (default), `3aab6e9c-eb7b-46a3-9ff4-2d15b64ab3e4` (mc-regional), from MarketCatalystUI prod 583b215. Change: 18 market-data collections deny all client reads (the backend reads them with the Admin SDK). Roll back in the Firebase console (Firestore → Rules → History) on each database, or `firebase deploy --only firestore:rules` from MarketCatalystUI at 1f4e4f9.
- Browser API key `833362a8-6eb3-4009-baad-75eceebb3788` ("Browser key (auto created by Firebase)"): before = no referrer restriction, 27 API targets; backup at `~/browser-key-backup-2026-11-20.json` on the deploying machine. After = 10 allowed referrers (our app, website, Firebase hosting domains, localhost) and 4 APIs (identitytoolkit, securetoken, firebaseinstallations, firebase). Roll back with `MarketCatalystUI/scripts/restrict-browser-key.sh rollback` (BACKUP=<path>), or remove restrictions in GCP console → APIs & Services → Credentials.
- No service, job or hosting change.

## 2026-11-20 — late-print filter for Polygon intraday bars (rollback values captured before)
- backend worker: `market-catalyst-backend-00325-t5h` (image `…/market-catalyst-backend@sha256:28999c6043811dacf55f0e3ca8b0acededc6963a1ef4da59389ea8fac367b306`)
- live API: `market-catalyst-live-00275-2mj` (image `…/market-catalyst-live@sha256:f0daf557da8373c721254a91c6434602f89d01c2d1e5a7c9b73ab7a66a4321ef`)
- premarket-job / history-backfill-job image: `…/market-catalyst-backend@sha256:28999c6043811dacf55f0e3ca8b0acededc6963a1ef4da59389ea8fac367b306`
- Code only (backend prod 1f32f93); no env, scheduler, rules or hosting change. Deployed: worker `market-catalyst-backend-00326-vjz`, live `market-catalyst-live-00276-btf`, jobs on `…market-catalyst-backend@sha256:e761223f5f86bd9d2d26a7c18e2987cdae93bb1a33f98f2c5a481683805a3e2c`.

## 2026-11-20 16:20 ET — Money Flow saved board (rollback values captured before)
- backend worker: `market-catalyst-backend-00326-vjz`; live API: `market-catalyst-live-00276-btf`; jobs image `…market-catalyst-backend@sha256:e761223f5f86bd9d2d26a7c18e2987cdae93bb1a33f98f2c5a481683805a3e2c`.
- Deployed (backend prod 5f3aee2): worker `market-catalyst-backend-00327-8sf`, live `market-catalyst-live-00277-ms9`, jobs on `…market-catalyst-backend@sha256:c458276e14b1365c3c80c2f43f4b124d3eeae79ee3a01233a4286fa714010352`.
- UI Hosting (site marketcatalyst): previous version `83300b475846cf0e`; new `055e7975a5e834db` (UI prod 104ce8f).
- Firestore rules: added `money_flow/latest` read for Pro+/staff (UI prod 104ce8f), both databases.
- New Cloud Scheduler job `sync-money-flow-snapshot` (`* 9-16 * * 1-5` America/New_York → worker /sync/money-flow-snapshot/run). New Firestore doc `money_flow/latest`.
- Fast off switch (no deploy): `gcloud scheduler jobs pause sync-money-flow-snapshot --location us-central1 --project market-catalyst-502415`. Within 10 minutes of the session the saved board is ignored by both the live API and the browser, and Money Flow builds on request as before. Full rollback: the revisions/version above, delete the scheduler job.

## 2026-11-20 16:32 ET — browser key: localhost on any port + Firestore API
- Key `833362a8-6eb3-4009-baad-75eceebb3788` before: 10 referrers incl. the non-matching `http://localhost:*/*` and `http://127.0.0.1:*/*` (blocked local dev); 4 APIs.
- After: 16 referrers (production unchanged; localhost/127.0.0.1 on ports 3000 and 3001 explicitly, plus `localhost`, `localhost:*`, `127.0.0.1`, `127.0.0.1:*` for any port); 5 APIs (added `firestore.googleapis.com`, needed by Money Flow's direct read of `money_flow/latest` — the Firestore web SDK sends the key). From MarketCatalystUI prod 5ca801d `scripts/restrict-browser-key.sh`; `verify` passes.
- Roll back: `scripts/restrict-browser-key.sh rollback` (BACKUP=~/browser-key-backup-2026-11-20.json restores the unrestricted original).

## 2026-11-20 17:18 ET — SendGrid live (real API key)
- Before: live `market-catalyst-live-00277-ms9`, worker `market-catalyst-backend-00327-8sf`, both with plain env `EMAIL_PROVIDER_API_KEY=SG.PLACEHOLDER` (emails only logged).
- After: live `market-catalyst-live-00278-rc7`, worker `market-catalyst-backend-00328-4zc`, `EMAIL_PROVIDER_API_KEY` from Secret Manager `SENDGRID_API_KEY:latest` (restricted key "marketcatalyst-prod-mail", Mail Send only). Domain marketcatalyst.ai authenticated in SendGrid (DKIM CNAMEs + DMARC p=none in Cloudflare); click/open tracking off. Account on SendGrid free trial until 2027-01-19 — upgrade before launch.
- Roll back: `gcloud run services update-traffic <svc> --to-revisions=<before>=100`, or swap the env back. Revoke the key in SendGrid → Settings → API Keys if it is ever exposed.
