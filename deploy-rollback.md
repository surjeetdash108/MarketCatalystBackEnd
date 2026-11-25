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

## 2026-11-20 — lifecycle email once per person + free-access wording
- Before: worker `market-catalyst-backend-00328-4zc`, live `market-catalyst-live-00278-rc7` (SendGrid secret already wired).
- After (backend prod 8d54406): worker `market-catalyst-backend-00329-mth`, live `market-catalyst-live-00279-rk2`, jobs on `…market-catalyst-backend@sha256:b8e79a160b6dc484aa2e23c34b8c4bbe2ba05d1f3b88c0a9e52c5817e19be880`. Env/secrets unchanged.
- New Firestore collections (written by the backend only): `email_sent/{emailHash}` (lifecycle mail sent per person), `email_optouts/{emailHash}` (promotional opt-out per person). Both kept on account deletion.
- Roll back: `gcloud run services update-traffic <svc> --to-revisions=<before>=100` for both services.

## 2026-11-24 ~11:00 ET — issue sheet T31-T51 (IPO job refresh + UI batch)
- Before: worker `market-catalyst-backend-00331-2hw`; premarket-job / history-backfill-job image `…market-catalyst-backend@sha256:3316aa91ac591db948ea625b87d2a8c58285ef86c648cb103880cdf5d9d2bf0f`. UI Hosting (site marketcatalyst) previous release 2026-11-24 16:33 IST.
- After (backend prod 3b2b041 merge): worker `market-catalyst-backend-00332-t7g`, both jobs on `…market-catalyst-backend@sha256:0c3f19ed6f8469d96c1f1db924d9c474bc7d23a5fb05811f9fae170e2d5baa45`. Live API unchanged. `ipos` job run once by hand: 143 rows written, 69 stale rows re-checked (past-dated "pending" 53 → 11).
- UI prod 9bdd0ff (T31-T51 batch). Firestore rules: added `users/{uid}/saved_screens` (owner-only), both databases.
- Website prod 9dab656 (homepage workspace count) via App Hosting auto-rollout.
- Roll back: `gcloud run services update-traffic market-catalyst-backend --to-revisions=market-catalyst-backend-00331-2hw=100`; `gcloud run jobs update premarket-job --image <before digest>` (same for history-backfill-job); UI: Firebase console → Hosting → marketcatalyst → roll back to the previous release.

## 2026-11-24 15:30 ET — Content pipeline (Blog / Pulse / Live Feed)
- Before: worker `market-catalyst-backend-00332-t7g` (image `…@sha256:0c3f19ed6f8469d96c1f1db924d9c474bc7d23a5fb05811f9fae170e2d5baa45`), live `market-catalyst-live-00281-hsd` (image `…@sha256:3316aa91ac591db948ea625b87d2a8c58285ef86c648cb103880cdf5d9d2bf0f`), premarket-job / history-backfill-job on `…@sha256:0c3f19ed…`.
- After (backend prod fab2ede): worker `market-catalyst-backend-00333-k78`, live `market-catalyst-live-00282-k6j`, both jobs on `…market-catalyst-backend@sha256:e4d86f5c5487b94d517cec44679c6b9d11b086d2968f0b2e6676d7574ae9ec92`. UI prod ddc13a1 (admin Content pipeline tab, pinned Live Feed posts).
- New infra (deploy/create-content-pipeline.sh): Pub/Sub API enabled; topics `content-pipeline`, `content-pipeline-dlq`; push subscription `content-pipeline-writer` → worker /sync/content-blog-writer/run (OIDC scheduler-invoker, ack 600 s, 5 attempts → DLQ); pull subscription `content-pipeline-dlq-pull`; Cloud Scheduler `sync-content-blog-writer` every 15 min; publisher role on the topic for the live (compute default) and worker (backend-runtime) service accounts. New Firestore collections `content_items`, `live_feed_posts`.
- AI key: ANTHROPIC_API_KEY is NOT set yet, so blog items wait as Queued ("AI key not set"). When the secret exists: `gcloud run services update market-catalyst-backend --region us-central1 --update-secrets=ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest` (worker only; it does the writing). Model defaults to claude-opus-5-5; switch with `--update-env-vars=CONTENT_AI_MODEL=claude-sonnet-5-5`.
- Roll back: `gcloud run services update-traffic <svc> --to-revisions=<before>=100` for both services; `gcloud run jobs update premarket-job --image <before digest>` (same for history-backfill-job); pause the pipeline with `gcloud scheduler jobs pause sync-content-blog-writer --location us-central1` and `gcloud pubsub subscriptions update content-pipeline-writer --push-endpoint=""`; UI: Firebase console → Hosting → roll back.

## 2026-11-25 ET — Chart/header match, IPO performance, Pulse rich text, analyst summary, landing copy
- Before: worker `market-catalyst-backend-00334-88p`, live `market-catalyst-live-00283-94q`, premarket-job / history-backfill-job, all on `…market-catalyst-backend@sha256:87b13e7410176d72fd3de305b7d68e04d0134b244579572e521ed6610ded0d8a`.
- After (backend prod 72e3685): worker `market-catalyst-backend-00335-9p5`, live `market-catalyst-live-00284-bv7`, both jobs on `…@sha256:12d361bcc27e40e734edb9946140f8f2b60ca292cc49bdeee9c899cc7c34314f`. Changes: daily chart bars refetched every 15 min during the session; Content pipeline has no length limits (pipeline Pulse posts skip the 500 cap); pipeline Pulse header sent as **bold**; Pulse search matches text and ticker only.
- UI prod 0005990 (Firebase Hosting): chart starts the forming candle from the live tick; candle-labelled readout + range change; Recent IPO performance lists only real IPOs that traded; Pulse rich text, no name line, admin toolbar/preview; stock analyst summary.
- Website prod e819499 (App Hosting rollout): landing 'included in every plan' copy corrected.
- Roll back: `gcloud run services update-traffic market-catalyst-backend --to-revisions=market-catalyst-backend-00334-88p=100` and `… market-catalyst-live --to-revisions=market-catalyst-live-00283-94q=100`; `gcloud run jobs update premarket-job --image <before digest>` (same for history-backfill-job); UI and website: Firebase console → Hosting / App Hosting → roll back.

## 2026-11-26 ET — 13F & Insider, SI/SL headers, Pulse, Recap, dashboard, stock page, heatmap; forward-estimates job
- Before: worker `market-catalyst-backend-00335-9p5`, live `market-catalyst-live-00284-bv7`, premarket-job / history-backfill-job, all on `…market-catalyst-backend@sha256:12d361bcc27e40e734edb9946140f8f2b60ca292cc49bdeee9c899cc7c34314f`.
- After (backend prod 8df7ede): worker `market-catalyst-backend-00336-m7m`, live `market-catalyst-live-00285-5g4`, both jobs on `…@sha256:d5f479707bc1…`. New job `forward-estimates` (premarket per-ticker phase) writes `nextFyEps` / `nextFyEnd` / `nextFyEpsAt` on companies docs of S&P 500 + NDX members; seeded by hand for all 518 members on 26 Nov. sectors.job now skips WARRANT/RIGHT/UNIT/SP types.
- UI prod a6d3c18 (Firebase Hosting).
- Roll back: `gcloud run services update-traffic market-catalyst-backend --to-revisions=market-catalyst-backend-00335-9p5=100` and `… market-catalyst-live --to-revisions=market-catalyst-live-00284-bv7=100`; `gcloud run jobs update premarket-job --image <before digest>` (same for history-backfill-job); UI: Firebase console → Hosting → roll back. The extra companies fields are harmless if left.

## 2026-11-26 ET — Site-audit fixes, Content pipeline edit/delete, Alpha Signals screens
- Before: worker `market-catalyst-backend-00336-m7m`, live `market-catalyst-live-00285-5g4`, both jobs on `…@sha256:d5f479707bc1…`.
- After (backend prod 908ad14): worker `market-catalyst-backend-00337-r2k`, live `market-catalyst-live-00286-wzv`, both jobs on `…@sha256:3a6d6ee4edbb…`. UI prod e6bdcdc (Firebase Hosting). Website prod bdadcd2 (App Hosting rollouts).
- Production data changed (backups in ~/Downloads/MarketCatalyst-backups-2026-11-26):
  - 203 blog posts corrected (B-03 wording, B-11 cent gaps, B-13 -$0.00, B-21 model notes removed, B-17/B-23 wording) — originals in posts/<id>.json.
  - 3 duplicate posts set to draft (rhTHxB9rABEwpsowWs1l, UsoYNkyBliHJOA3FPOVV, baH44tAsES2qaoyUoYCn) + 301s in the website's DUPLICATE_POSTS.
  - 8 FAQ entries reworded (faq-03/06/09/10/12/13/14/16) — originals in faqs-backup-2026-11-26.json.
  - sync_watermarks/stock-history__{SXTC,SCCO,SOXX,AIIO,STKH,SNDK} deleted so the next stock-history run re-fetches split-adjusted history.
- NOT done (blocked by the auto-mode check): Cloud Scheduler `sync-eod-recap` is still `15 16 * * 1-5`; to move it: `gcloud scheduler jobs update http sync-eod-recap --location us-central1 --project market-catalyst-502415 --schedule="45 16 * * 1-5"`.
- Roll back: `gcloud run services update-traffic market-catalyst-backend --to-revisions=market-catalyst-backend-00336-m7m=100` and `… market-catalyst-live --to-revisions=market-catalyst-live-00285-5g4=100`; jobs `--image …@sha256:d5f479707bc1…`; UI/website via the Firebase console; restore posts/FAQs from the backup JSON (PATCH the saved fields).
