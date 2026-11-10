# MarketCatalyst — engineering handoff

Written 2026-11-10 (≈14:30 ET) for the next coding agent. It assumes no access to earlier conversations. Everything here was checked against the repos and (read-only) production at that time.

**This file contains no secret values.** Secrets are referred to by name only. Never print, log or write a secret value anywhere, including this file.

---

## A. Project overview

### Repos

All three are under `~/MarketCatalyst/` and on GitHub (`surjeetdash108/...`).

| Repo | What it is | Hosted on |
|---|---|---|
| `MarketCatalystBackEnd` | NestJS API, sync jobs, billing, entitlements. Firebase Admin SDK to Firestore. Data from FMP (primary) and Polygon/Massive (fallback/streams). | Cloud Run, region `us-central1`, project `market-catalyst-502415` |
| `MarketCatalystUI` | Next.js app (`app.marketcatalyst.ai`), static export. Owns `firestore.rules`. | Firebase Hosting, site `marketcatalyst` |
| `MarketCatalystWebsite` | Next.js marketing site (`marketcatalyst.ai`). The homepage is `lib/landing/home.html`, filled with prices from `/plans` (fallback: `lib/pricing/catalog.json`). | Firebase App Hosting, backend `marketcatalystwebsite` (us-east4). A push to `prod` triggers a rollout. |

The root folder `~/MarketCatalyst` is also a git repo. It holds validation scripts (`validate_e2e`, the regression suite) and excludes the three subprojects.

### Runtime pieces

| Piece | What it is |
|---|---|
| `market-catalyst-backend` | Cloud Run worker: private, `--no-allow-unauthenticated`, `ADMIN_GUARD_TRUST_IAM`. Serves admin routes, sync, the ops monitor `public/index.html` (feature-flag toggles) and the scheduler targets. |
| `market-catalyst-live` | Cloud Run public API behind `app.marketcatalyst.ai/api`, `/live`, `/market-data`, `/plans`. Handles the Stripe webhook `POST /api/billing/webhook`. |
| `premarket-job`, `history-backfill-job` | Cloud Run jobs. They run `AppJobModule` (`src/app-job.module.ts`). They **must use the same image digest as the services**. |
| Firestore | Production data is in database **`mc-regional`**: both services set `FIRESTORE_DATABASE_ID=mc-regional`. `(default)` also exists, has its own rules release, and is kept in step. Rules are deployed to both from `MarketCatalystUI/firestore.rules`. |

### Data sources

- FMP is the primary source (`MARKET_DATA_PRIMARY`).
- Polygon/Massive is the fallback and live stream (`POLYGON_API_BASE_URL`, `LIVE_STREAM_SOURCE`).
- FRED for macro; SEC EDGAR for filings (`SEC_EDGAR_USER_AGENT`).
- LLMs via OpenRouter/Groq.
- Yahoo and TradingView are **comparison only**, in validation scripts. Never use them as an app data source, and never rename our sector labels to match TradingView.

### Branch model

- **`prod` deploys.** The Website auto-rolls out on a push to `prod`. The UI and backend are deployed by hand, see §F.
- **`main` = `prod`.** After merging to `prod`, merge `prod` into `main` so the trees are identical; check with `git diff prod main` (empty).
- Work happens on feature branches. Old main commits are archived under tag `archive/main-2026-11-10` in UI and Website.

### Running tests and builds locally

Use Node 22: the Dockerfile uses `node:22-slim`. The local machine had Node 26 and that worked, but 22 is what production runs.

| Repo | Tests | Build | Other |
|---|---|---|---|
| BackEnd | `npx jest` (≈1400 tests, ~10 s) | `npm run build` | `npx tsc --noEmit -p tsconfig.json`; `npx eslint <files>` (repo-wide lint has a large pre-existing baseline: compare counts on changed files only) |
| UI | `npm test` (node:test via tsx) | `npm run build` (static export to `out/`) | `npm run test:rules` (Firestore emulator; needs Java + firebase-tools) |
| Website | `npm test` | `npm run build` | |

Regenerating the catalog copies is **mandatory after any registry change**:
- Write: `cd MarketCatalystBackEnd && npx ts-node --transpile-only scripts/export-catalog.ts`.
- `--check` fails if any copy is stale; the catalog spec also checks it.

The catalog writes into the UI and Website working trees, so those repos must be on the matching branch when you run it.

---

## B. Rules every agent must follow

1. **Keys come from env or Secret Manager only.**
   - Never print, log, echo or write a key or token. Never read shell history.
   - Secrets are entered with `read -rs` and piped into `gcloud secrets versions add NAME --data-file=-`.
2. **No production writes, deploys, or env/scheduler changes without the owner's explicit OK for that step.** An approval in one step does not carry over to the next.
3. **Deploy windows.** Backend and jobs deploy only outside US market hours (09:30–16:00 ET) and outside 07:55–08:30 ET. Check there is no running job execution:
   `gcloud run jobs executions list --job <job> --filter="NOT status.completionTime:*"`
4. **Before every deploy:**
   - Save rollback values to `deploy-rollback.md` and update `scripts/rollback.sh`.
   - After the deploy, run smoke checks and look at 10 minutes of logs.
   - Roll back if any smoke check fails.
5. **Billing safety:**
   - The fake billing provider is refused in production (startup error; `provider.factory.ts`).
   - Stripe runs in **test mode only** until the owner approves live. `sk_live_` is refused at startup unless `STRIPE_LIVE_APPROVED=true`; the UI refuses `pk_live_` unless `NEXT_PUBLIC_STRIPE_LIVE_APPROVED=true`.
   - Never build card fields of our own: card entry is only Stripe's Payment Element.
   - `SUBSCRIPTIONS_ENABLED` stays **off** until launch.
6. **No personal data we don't need.** No card data, government IDs (PAN etc.) or date of birth on our servers. Email verification only: no phone or WhatsApp OTP.
7. **Commits and tests.**
   - One commit per change, each with tests that **fail before and pass after**.
   - No hard-coded users, prices or promo codes in app code.
   - Never use a real person's email as a placeholder.
8. **Data sources.** Yahoo and TradingView appear only in validation scripts. TradingView label differences are not bugs.

---

## C. Subscription system: what's done

**Where things are.** File:line references are on branch **`wip/plans-no-free-feature-groups`**, which contains everything on `prod` plus the WIP. Lines on `prod` may differ slightly.

**Status key:**
- **LIVE**: deployed in production.
- **PROD-BRANCH**: on `prod`, not deployed.
- **WIP-BRANCH**: only on `wip/plans-no-free-feature-groups`.

Production runs backend image `sha256:1bbb904c…` from **before** the go-live-readiness work. Everything billing-related newer than that is PROD-BRANCH at best. The UI and Website on `prod` **are** deployed (LIVE).

| Part | Where | Tests | Status |
|---|---|---|---|
| **BillingProvider interface** | `src/billing/provider/billing-provider.ts:54`; types in `provider/types.ts` | provider specs | PROD-BRANCH (change kinds: WIP) |
| **Fake provider + clock.** Simulated hosted checkout, cards, 3DS, renewals, retries, tax, credit balance. | `provider/fake/fake-billing.provider.ts:201`; test controller `fake-billing.controller.ts` | `fake-billing.provider.spec.ts` | PROD-BRANCH; refused in production |
| **Stripe adapter** (stripe@18, API `2025-08-27.basil`, embedded deferred-intent checkout, `automatic_tax`) | `provider/stripe/stripe-billing.provider.ts:141`; `STRIPE_EVENT_MAP` at `:66` | `stripe-billing.provider.spec.ts` | PROD-BRANCH |
| **Provider factory** (fake refused in prod; live-key refusal) | `provider/provider.factory.ts:38` | `fake-billing.provider.spec.ts` › "provider factory safety" | PROD-BRANCH |
| **Event handler: the only writer** of mirror, projection, claims, payments, history and emails | `billing-events.service.ts:176` (`handle`), `:152` (`receive`) | `billing-events.service.spec.ts` | PROD-BRANCH |
| **Nightly reconcile** | `src/billing/reconcile.job.ts` (`RECONCILE_JOB`) | `billing.e2e.spec.ts` › "nightly reconcile" | PROD-BRANCH |
| **Webhook**: signature over the raw body; unsigned events get 400; events from the other mode are ignored | `billing.controller.ts` `BillingWebhookController`; `parseEvent` in the Stripe adapter | "rejects unsigned/tampered events", "ignores events from the other mode" | PROD-BRANCH (production has no provider → 503) |
| **Flag `SUBSCRIPTIONS_ENABLED`** (off in production by default) | `src/feature-flags/feature-flags.registry.ts:39`; `billing-access.service.ts` | `subscriptions-flag.spec.ts`, `billing.e2e.spec.ts` "SUBSCRIPTIONS_ENABLED and provider safety" | LIVE (off) |
| **Flag `CHECKOUT_PREVIEW`** (staff-only checkout, Stripe test mode) | registry `:56`; `src/billing/checkout-preview.ts:55`; `billing-access.service.ts:59` | `checkout-preview.e2e.spec.ts` | PROD-BRANCH (flag unknown to the production backend) |
| **Test-mode records** (`livemode:false`, excluded from metrics, Test badge, purge script) | `src/billing/livemode.ts:7`; `test-mode-purge.ts:45`; `scripts/purge-test-billing.ts` | `test-mode-purge.spec.ts`, `admin-analytics.revenue.spec.ts` | PROD-BRANCH |
| **Catalog** | `src/plans/plans.registry.ts`: `FEATURE_GROUPS` :431, `PLAN_DEFINITIONS` :500. `catalog-apply.ts:199`, `scripts/apply-catalog.ts` (backup first, dry run default) | `plans.catalog.spec.ts`, `catalog-contract.spec.ts` | Production Firestore has catalog **v2** applied (with Free). v3 (no Free) is WIP-BRANCH. |
| **Checkout** (2 steps: billing period → payment; consent, E.164 mobile, address, promo; email must be verified) | `billing.service.ts:342` (checkout), `:275` (preview); UI `app/iq/billing/checkout/checkout-page.tsx:26` | `checkout-v2.e2e.spec.ts`, UI `checkout.spec.tsx` | Backend PROD-BRANCH; UI LIVE (shows "launching soon") |
| **Signup** (plan intent from tile → sign-up → verify → /checkout) | UI `app/auth/signup/signup-form.tsx:27`, `app/iq/billing/plan-intent.ts` | UI `signup-no-plan-picker.test.mjs` | LIVE, but no plan step — see E1 |
| **Promo engine** (percent/amount, once/repeating/forever, plan/interval limits, expiry, max uses, first-time only, generic error, 10/hour per user + IP) | `promo/promo.service.ts:255` (validate), `:301` (rate limit) | `promo.service.spec.ts`, `billing.e2e.spec.ts:234` | PROD-BRANCH |
| **Signup promo check** (signed out) `POST /api/billing/signup/promo` | `billing.controller.ts:264` | `promo/signup-promo.e2e.spec.ts` | WIP-BRANCH |
| **Upgrade** (immediate, prorated, exact preview match, 3DS) and **downgrade** (immediate, prorated, credit; annual → monthly scheduled) | `billing.service.ts:65` (`classifyChange`), `:122` (`changeBreakdown`); both providers' `previewChange`/`changePlan` | `billing.e2e.spec.ts` › "upgrade and downgrade" (12 tests incl. day 10 of 30 to the cent and the edge cases) | Upgrade PROD-BRANCH; downgrade/breakdown/credit WIP-BRANCH |
| **Cancel** at period end (monthly → month end, annual → year end) | `billing.service.ts:722`; Stripe `cancelAtPeriodEnd` | "cancel anytime" (monthly/annual) | PROD-BRANCH |
| **Retention**: 50% × 2 months on cancel (annual: credit); once per normalised email ever | `retention/retention.service.ts:28`; `retention/email-normalise.ts:11` | `billing.e2e.spec.ts` › retention (549, 599, 614, 658), `email-normalise.spec.ts` | PROD-BRANCH |
| **Refunds**: `REFUND_WINDOW_DAYS` = 14; first payment (once per person) or annual renewal | `refund/refund-policy.config.ts:10`; `refund.service.ts:135` | `refund.e2e.spec.ts`, `refund-policy.spec.ts` | PROD-BRANCH |
| **History**: invoices, documents, subscription events; line items stored on payments | `billing.service.ts:845` (invoices), `:889` (history); lines written at `billing-events.service.ts:731` | `billing.e2e.spec.ts` › "history: payment records carry line items" | PROD-BRANCH; line items WIP-BRANCH |
| **Entitlements and guard**: global guard reads `ROUTE_FEATURES` / `PLAN_EXEMPT_ROUTES` | `src/entitlements/entitlement.guard.ts:56`; `route-inventory.ts`; registry `:611`, `:732` | `entitlement.guard.spec.ts` (contract + access matrix) | WIP-BRANCH; on `prod` the per-route `@RequiresEntitlement` version |
| **Firestore rules**: `canReadOnPlan`, `isStaff`, generated section | `MarketCatalystUI/firestore.rules` | UI `tests/rules/*.test.mjs` (129) | LIVE: rulesets in §F (old gates). Generated section WIP-BRANCH (UI) |
| **UI gate** (`EntitlementGate`, `LockedFeature`, widget gates) | `app/iq/entitlement-gate.tsx:21`; `app/iq/screens/dashboard.tsx` | `entitlement-gate.spec.ts`, `dashboard-gate.spec.tsx` | LIVE (no-op while the flag is off) |
| **Staff allowlist** (`config/staff_access`, verified email only, `staff` claim, full access, never billed) | `src/account/staff-access.service.ts:23`; `POST /api/account/sync-claims`; admin `/api/admin/staff-access` | `staff-access.e2e.spec.ts`, `staff-seed.spec.ts` | Allowlist seeded in production (3 addresses — not listed here) |
| **Admin billing**: subscribers (filters, CSV, detail, phone reveal audited, refunds, staff/legacy/Test badges), promos, audit, price-change notice | `admin-billing.controller.ts:26`; `admin-billing.service.ts:159`; UI `app/admin/billing/admin-billing.tsx` | `admin-billing.e2e.spec.ts`, UI `admin-billing-v2.spec.ts` | Backend PROD-BRANCH; UI LIVE |
| **Email**: SendGrid v3 adapter, retries; paid checkout needs email delivery in production | `email/sendgrid-email-sender.ts:37`; `email/email-provider.ts:29` (`emailDeliveryReady`) | `sendgrid-email-sender.spec.ts`, `email.service.spec.ts` | PROD-BRANCH (`EMAIL_PROVIDER` unset in production) |
| **Mobile number + consent** (E.164, masked in admin; consent text + version recorded) | `checkout/phone.ts:9`; `checkout/consent.ts:8` | `phone.spec.ts`, `checkout-v2.e2e.spec.ts` | PROD-BRANCH |
| **Tax**: Stripe Tax only (Texas registration first); no rates in our code | Stripe adapter `automatic_tax`; fake simulated rates `provider/fake/fake-tax.config.ts` | UI "no tax rates in the UI" | Needs dashboard setup (G) |
| **Launch migration**: 30 days of Pro; the 2 legacy `currentPlan=pro` users get 90 days and "Legacy Pro"; staff excluded; first-year code | `launch/launch-migration.ts:60`; `scripts/launch-migration.ts` | `launch-migration.spec.ts` | Not run; needs the owner's OK |
| **go-live-check** (read-only readiness, test or live mode) | `go-live/go-live-check.ts:61`; `npm run go-live-check -- --mode=test` | `go-live-check.spec.ts` | PROD-BRANCH |
| **check-placeholders** | `scripts/check-placeholders.mjs:48`; `docs/PLACEHOLDERS.md` | `check-placeholders.spec.ts` | PROD-BRANCH |
| **Rollback script** | `scripts/rollback.sh` (prints commands; `--execute` runs them); values in `deploy-rollback.md` | — | Current (values captured 2026-11-10 11:30 ET) |
| **Generated copies** (UI catalog, website catalog.json, refund copy, UI feature map, rules section, `docs/FEATURE-MAP.md`) | `scripts/export-catalog.ts` | catalog spec "catalog copies in other repos" | Feature-map/rules generation is WIP-BRANCH |

---

## D. The owner's requirements (verbatim) and their status

| # | Requirement | Status |
|---|---|---|
| 1 | Plan choice at sign-up; the landing-page tile preselects. | **Partly.** The tile's plan rides through sign-up to checkout. Signup has **no plan cards yet** (UI work, E1). |
| 2 | Promo code at sign-up. | **Partly.** The backend endpoint is done (WIP). UI field not built (E1). |
| 3 | Upgrade anytime, prorated (plan 1 until now + plan 2 for the rest), amount shown. | **Backend done** (breakdown, exact cents, WIP). UI shows one total; the breakdown UI isn't built (E3). |
| 4 | Downgrade anytime, prorated the same way, amount shown. | **Backend done** (immediate, credit, WIP). UI copy still says "at period end" (E3). |
| 5 | Cancel anytime; monthly ends at month end, annual at year end. | **Done** (backend PROD-BRANCH; UI LIVE). After the end: "Choose a plan" screen not built (E2). |
| 6 | On cancel, offer 50% off for 2 months; continue → discount applied; once per email. | **Done** (PROD-BRANCH). |
| 7 | Payment and subscription history. | **Backend done** incl. line items (WIP). UI doesn't show lines or the credit balance yet (E4). |
| 8 | Plan features only. No free plan: Starter = Market Desk + Stock Intelligence; Pro = + Money Flow; Elite = + Strategy Lab. Full names in the UI, never abbreviations. | **Done.** Backend registry, global guard, and contract/matrix tests pass; UI wired to generated map via `SCREEN_FEATURES` / `LOWEST_PLAN`; "Choose a plan" screen implemented (0 data calls); Website tiles and bullets generated from `catalog.json` tokens. (E1–E6 done). |
| 9 | Admin: subscribers, plans, expiry dates, promo code management. | **Done.** Admin Free filter removed, invoice lines rendered, and subscriber credit balance displayed (E4 done). |

### Decisions already made (do not re-open)

- **Downgrades:** the difference goes to **account credit** (used automatically on the next invoices), never refunded to the card. Annual → monthly takes effect **at the end of the annual period**.
- **Refunds:** 14-day window (`REFUND_WINDOW_DAYS=14`).
- **No plan:** no free plan. An account with no active plan (never paid, cancelled and ended, refunded, or past the 7-day past-due grace) sees only account / billing / legal pages plus a full-page "Choose a plan to continue". Backend routes return 403 `{code:"plan_required"}`.
- **Flag off:** `SUBSCRIPTIONS_ENABLED` off = everyone keeps everything (today's behaviour).
- **Launch migration:** 30 days of Pro for existing non-paying users; 90 days for the 2 legacy Pro users ("Legacy Pro"); staff excluded. The first-year code's prefix and percent are still placeholders.
- **Staff:** full access, never billed. Emails live only in Firestore `config/staff_access`; never list them in docs or code.
- **Verification and personal data:** email verification only (no WhatsApp/phone OTP). No DOB, PAN or government IDs.
- **Email:** SendGrid (`EMAIL_PROVIDER=sendgrid`).
- **Tax:** Stripe Tax, Texas registration first. Payment methods `card,link` (PayPal is config-only); never crypto or UPI.
- **Other:** Portfolio is a Starter (Market Desk) feature. The Strategy Lab universe runner defaults to a 1-year backtest.

### Feature map

Generated from `plans.registry.ts` on the WIP branch; the same as `docs/FEATURE-MAP.md` there.

**Plans:**

| Plan | Feature groups |
|---|---|
| Starter | Market Desk, Stock Intelligence |
| Pro | + Money Flow |
| Elite | + Strategy Lab |

**Without a plan, only these routes:** `/api/account`, `/api/session`, `/api/whoami-user`, `/api/profile`, `/api/settings`, `/api/billing`, `/api/me`, `/plans`, `/health`, `/public`, `/mcp` (admin-issued key), `/live/stream` and `/live/tape/stream` (need a ticket, issued only on a plan).

**Without a plan, only these screens:** auth, verify-email, settings, profile, manage-plan, checkout, billing, legal, version.

**Feature groups:**

| Group | Features → screens / widgets / routes |
|---|---|
| **Market Desk** (Starter+) | Market Dashboard (dashboard, requests; tape, snapshot, market-status, sentiment, notifications, stream-ticket, companies/quotes/search shared). News & Commentary (commentary; news, news-wire). Market Movers (movers; scan/*, movers, volume-leaders). Sector Heatmap (sectors). Macro & Calendars (macro-events, macro-regime, dividends calendar). IPO Corner (ipos, ipo-pipeline). Earnings Hub (earnings, earnings-announcements, earnings-wire). Market Recaps (recaps). Watchlist (watchlist(s), no ticker limit). All workspaces (analyst actions, ETF Corner, AI Companies, filings wire, mover catalysts, glance, filing, ticker-announcements; widget dashboard.analyst). Stock Screener (companies, company). 13F & Insider (insider-transactions, institutional-ownership, fund-holdings, ownership, ownership-13dg, 13f-filings; widget dashboard.insider). Portfolio (portfolio routes; widgets dashboard.portfolio, commentary.portfolio). |
| **Stock Intelligence** (Starter+) | Stock page (stock/si; company, company/summary, splits, news, quotes). Daily / intraday / 5-year charts (`/live/bars`, resolved by `tf`/`interval`). Chart indicators, technical ratings, themes (computed in the browser from companies/bars). Chart notes (stock-notes). Financials. Dividend history. Peers. Earnings detail (estimates, transcripts, summaries). AI research (ai-analysis, ticker-analysis, copilot, /api/ai/*). Trade Builder & Tracker (browser-only; widget stock.tradeBuilder). |
| **Money Flow** (Pro+) | Money Flow + institutional movers (`/live/money-flow`; gainers/losers are inside it). Options chain (`/live/options-chain`; hidden screen `options`). |
| **Strategy Lab** (Elite) | Strategy Lab (universe, validate, ai-rules, saved) and backtesting (`/live/strategy-lab/bars`); entry/stop/target levels are inside Strategy Lab. |
| **Client-denied Firestore** | `earnings_summaries`, `options_flow`, `block_trades`, `fund_holdings`, `story_stocks`. **No browser reads any Firestore collection** (the UI imports no `firebase/firestore`); everything goes through the backend. |

---

## E. Remaining work (ordered)

**Effort:** S < ½ day, M ≈ 1 day, L > 1 day.

**"OK"** means the owner must approve the step. **"Value"** means the owner must supply something.

### E0. Pending deploy of what is already on `prod` (backend + jobs) — S, OK

- **Goal:** production backend = `prod` (staff preview, Stripe test-mode code, go-live work).
- **How:**
  - In a deploy window, refresh rollback values (`deploy-rollback.md`, `scripts/rollback.sh`).
  - Deploy from a clean worktree of `origin/prod`: `gcloud run deploy market-catalyst-backend --source . --region us-central1 --project market-catalyst-502415`.
  - Take the new revision's `status.imageDigest`. Deploy `market-catalyst-live --image <digest>`. Run `gcloud run jobs update premarket-job --image <digest>` and the same for `history-backfill-job`.
  - Boot check: `gcloud run jobs execute premarket-job --update-env-vars SYNC_JOB=__boot_check__ --wait`. It is expected to exit 1 with "Unknown job"; confirm that line in the logs.
  - Look at 10 minutes of ERROR logs on both services.
  - Smoke checks (no secrets in them):
    - `/plans` has `paidPlansAvailable:false`;
    - the webhook is not 200;
    - signed-out data routes return 401;
    - signed-out `/checkout` goes to `/auth/signup`;
    - the `CHECKOUT_PREVIEW` flag exists and is OFF;
    - `BILLING_PROVIDER` / `SUBSCRIPTIONS_ENABLED` / `STRIPE_LIVE_APPROVED` are unset on the live service.
- **Risk:**
  - First deploy of a large billing change set. Everything is flag-gated, so behaviour is unchanged while the flags are off.
  - The **global** guard only arrives with E2; `prod` still uses per-route decorators.

### E1. Signup with plan + promo — **DONE**
- Implemented plan cards, interval switch, and promo input on signup page. Preselection parses `?plan=&interval=`. Promo validated via `POST /api/billing/signup/promo`. Intent persisted across auth redirects (including Google) into `/checkout`. Tests in `tests/ui/signup-no-plan-picker.test.mjs`.

### E2. "Choose a plan" screen + no free plan in the UI — **DONE**
- Implemented `ChoosePlanScreen` when `subscriptionsEnabled && !staff && planId === "none"` on protected screens, making 0 data calls. Removed all "Move to Free" buttons and Free plan mentions.

### E3. Change dialog: upgrade/downgrade breakdown — **DONE**
- Implemented proration breakdown rendering (`usedOnCurrent`, `newPlanCharge`, `alreadyPaid`, `chargedNow` / `creditToBalance`), schedule note for annual -> monthly, `expectedCredit` / `expectedAmountDue` sent on confirm, and automatic re-preview on `preview_stale`.

### E4. History line items + credit balance in the UI — **DONE**
- Implemented invoice line items (`lines`) rendering in Manage Plan and Admin subscriber detail, and display of `creditBalance` in both places. Tested in `admin-billing-v2.spec.ts`.

### E5. Wire the UI to the generated feature map — **DONE**
- Replaced `SLUG_ENTITLEMENT` with `SCREEN_FEATURES` and `LOWEST_PLAN` in `entitlement-gate.tsx`. Renamed "All 15 Workspaces" to "All workspaces". Added complete access matrix test suite (`tests/ui/entitlement-access-matrix.test.mjs`) and contract tests.

### E6. Copy (no Free anywhere; full names) — **DONE**
- Website `home.html` updated with `{{BULLETS:<plan>}}` and `{{EVERY_PLAN_INCLUDES}}` tokens. Terms §12 and Privacy copy updated in UI and Website (flagged for legal review). Zero mentions of "Free plan" in app or email copy. Tested in `tests/pricing-plans.test.ts` and `email.service.spec.ts`.

### E7. Catalog v3 apply in production — S, OK

- Run `npx ts-node --transpile-only scripts/apply-catalog.ts --project=market-catalyst-502415 --database=mc-regional --auth=gcloud` (dry run by default). Then `--apply --confirm-production`.
- It backs up to `catalog-backups/` first, sets Free and plus `active:false` (never deletes), and is idempotent.
- Until it runs, the backend serves the registry catalog: `isCatalogApplied` treats v2 as stale, so `/plans` already has no Free after the WIP deploy.

### E8. Merge the WIP and deploy everything — M, OK

- Rebase/merge `wip/plans-no-free-feature-groups` into a feature branch, split it into one commit per change, and check fail-before for each:
  - registry/groups;
  - global guard + contract;
  - change kinds;
  - line items;
  - signup promo;
  - copy;
  - generated copies.
- In the next window, deploy backend + both jobs + UI (`firebase deploy --only firestore:rules,hosting` from `MarketCatalystUI`, which deploys both databases' rules) + Website (push `prod`), with `SUBSCRIPTIONS_ENABLED` and `CHECKOUT_PREVIEW` off.
- **Smoke checks:**
  - current users still have full access;
  - signup shows the three plans with the tile preselected;
  - the tiles show the new bullets with no Free;
  - `/plans` has no Free;
  - the webhook is not 200;
  - 10 minutes of clean logs.
- **Screenshots** (fake provider, local stack, desktop + mobile):
  - signup with the tile preselected + promo;
  - checkout with the promo;
  - the upgrade breakdown;
  - the downgrade breakdown + credit;
  - history with line items;
  - "Choose a plan";
  - locked Money Flow on Starter and locked Strategy Lab on Pro;
  - the admin subscriber detail.

### E9. Stripe test setup + staff walkthrough — S, Value

- Owner steps in §G. Then:
  - run the seed and `go-live-check --mode=test`;
  - turn on `CHECKOUT_PREVIEW`;
  - walk through: staff → tile → card 4242 (success), 4000 0000 0000 0002 (decline), 4000 0025 0000 3155 (3DS);
  - `npm run purge-test-billing` (dry run first) to clean up.

### E10. Staging walkthrough — M, OK

- A full run with the fake provider and `SUBSCRIPTIONS_ENABLED=true` on a non-production project or the emulators: signup → checkout → upgrade/downgrade → cancel → "Choose a plan".

### E11. Legal review — Value

- Terms, Privacy, refund and consent text (`checkout/consent.ts` `CONSENT_VERSION`).

### E12. Admin MFA, then remove the overrides — S, OK

- Both services have `ADMIN_REQUIRE_EMAIL_VERIFIED` / `ADMIN_REQUIRE_MFA` overrides set because the admin account has no MFA yet.
- Once the admin enrols MFA, remove those env overrides from both services (deploy window).

### E13. Email, live keys, launch — L, OK + Value

- **Email first:** SendGrid domain authentication and `EMAIL_*` variables. Production paid checkout is refused until `emailDeliveryReady`.
- **Then live mode:**
  - live Stripe keys;
  - `STRIPE_LIVE_APPROVED=true` (backend) and `NEXT_PUBLIC_STRIPE_LIVE_APPROVED=true` (UI build);
  - the live webhook secret.
- **Launch migration:** dry run, then apply (OK).
- **Switch on:** `SUBSCRIPTIONS_ENABLED` on via the ops monitor.
- Follow the order in `docs/GO-LIVE.md` §4.

---

## F. Current production state

Read-only check, 2026-11-10 ≈14:10 ET.

### Revisions, images, rules and builds

| What | Value |
|---|---|
| market-catalyst-backend | revision `market-catalyst-backend-00296-987` (100%), image `us-central1-docker.pkg.dev/market-catalyst-502415/cloud-run-source-deploy/market-catalyst-backend@sha256:1bbb904ce118405cef6172abe41615fb61bc2badc2af715f7ad835e498dd240a` |
| market-catalyst-live | revision `market-catalyst-live-00239-g84` (100%), same image |
| premarket-job, history-backfill-job | image `…market-catalyst-backend@sha256:f8b5f1222196ce036bd53f1d8aa3f89518c9b9f68545b4463febb33530cd75e3` (older than the services — E0 aligns them) |
| Firestore rules | `(default)` release `cloud.firestore` → ruleset `612d55fe-dae3-4242-bc70-e160397016c0`; `mc-regional` release `cloud.firestore/mc-regional` → `bb613c7d-8a3d-4e96-a487-ae79227efc75` |
| UI Hosting | site `marketcatalyst`, version `0de2b6a15dbff4df` (UI `prod` c77a974) |
| Website | App Hosting build `build-2026-11-10-003` (commit 3371f3a), 100% |

### Branch SHAs

Before this handoff commit.

| Repo | prod | main | WIP branch |
|---|---|---|---|
| BackEnd | `3ad06c2` | `8eb6d8d` | `wip/plans-no-free-feature-groups` @ `c1ee822` |
| UI | `c77a974` | `e82902c` | `wip/plans-no-free-feature-groups` @ `8d83f9e` |
| Website | `3371f3a` | `7b7d302` | `wip/plans-no-free-feature-groups` @ `e3acc52` |

### Flags and seeded data

- `SUBSCRIPTIONS_ENABLED`: off (registry default; no override).
- `CHECKOUT_PREVIEW`: not known to the deployed backend.
- `FF_*` release flags: as set in `feature_flags/default` (read them via the ops monitor; don't change them).
- Live-service env includes `FIRESTORE_DATABASE_ID`, `ADMIN_GUARD_TRUST_IAM`, `ADMIN_REQUIRE_EMAIL_VERIFIED`, `ADMIN_REQUIRE_MFA` and the data-vendor keys. **Unset:** `BILLING_PROVIDER`, `SUBSCRIPTIONS_ENABLED`, `STRIPE_*`, `EMAIL_PROVIDER`.
- **Seeded:**
  - `config/staff_access`: 3 addresses (2026-11-10).
  - Plan catalog **v2**: 5 writes; backup `catalog-backups/plans-backup-2026-11-10T15-24-22-492Z.json`.
  - The launch migration has **not** run.

### Rollback

- `deploy-rollback.md` holds the values captured before the staff-preview deploy, and they equal the table above: backend revisions; job image; rulesets; hosting `1678375610c23695`, the version *before* the 16:22 UTC UI deploy; website `build-2026-11-10-002`.
- `bash scripts/rollback.sh` prints the commands (no token is fetched). `bash scripts/rollback.sh --execute` runs them.
- **Update both files before every deploy.**

---

## G. Owner steps

### Variables

Names only. Full table in `docs/GO-LIVE.md` §1. Add secrets with the `put_secret NAME` helper there, which uses `read -rs` → `--data-file=-`.

| Name | Kind | Where it goes |
|---|---|---|
| `STRIPE_SECRET_KEY` | secret, `sk_test_…` now | both services |
| `STRIPE_WEBHOOK_SECRET` | secret | live service |
| `STRIPE_PORTAL_CONFIGURATION` | plain | live service, printed by the seed |
| `STRIPE_PAYMENT_METHOD_TYPES` | plain, `card,link` | both services |
| `BILLING_PROVIDER` | plain, `stripe` | both services |
| `STRIPE_PRODUCT_TAX_CODE` | plain | shell, for the seed |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | plain, `pk_test_…` | UI build, `MarketCatalystUI/.env.production.local` (gitignored) |
| `NEXT_PUBLIC_STRIPE_PAYMENT_METHOD_TYPES` | plain | UI build |
| `EMAIL_PROVIDER`, `EMAIL_FROM_NAME`, `EMAIL_FROM_ADDRESS`, `EMAIL_REPLY_TO` | plain | both services |
| `EMAIL_PROVIDER_API_KEY` | secret | both services |
| `STRIPE_LIVE_APPROVED`, `NEXT_PUBLIC_STRIPE_LIVE_APPROVED` | plain | **leave unset** until live is approved |
| `LAUNCH_PROMO_PREFIX`, `LAUNCH_PROMO_PERCENT` | plain | shell, for the launch migration |

### Stripe test mode, turning on `CHECKOUT_PREVIEW`, the path to the card form

All in `docs/GO-LIVE.md` **§0**, step by step:
- 0.1: the keys and the webhook endpoint for `https://app.marketcatalyst.ai/api/billing/webhook` with the `STRIPE_EVENT_MAP` events;
- 0.2: the secret and env commands, and the UI rebuild with `pk_test_`;
- 0.3: the seed and `go-live-check --mode=test`;
- 0.4: `gcloud run services proxy market-catalyst-backend --region us-central1 --project market-catalyst-502415 --port 8080`, then open http://localhost:8080 → Feature flags → `CHECKOUT_PREVIEW`;
- 0.5: the walkthrough with test cards;
- 0.6: purging test data.

**Prerequisite:** E0 (the backend deploy).

### Go-live order

`docs/GO-LIVE.md` §4:
1. Variables.
2. Stripe test-mode run (local + staff preview).
3. SendGrid domain + test email.
4. Legal review.
5. Admin MFA.
6. Catalog apply.
7. Live Stripe setup (repeat §2 in live mode, `STRIPE_LIVE_APPROVED`).
8. Launch migration.
9. Signed-in smoke (§5).
10. `SUBSCRIPTIONS_ENABLED` on.

---

## H. Known issues and gotchas

- **Images:** jobs must run the **same image digest** as the services. Deploy the worker with `--source`, then point live and both jobs at its `status.imageDigest`.
- **`AppJobModule`** (`src/app-job.module.ts`) has its own `imports`. A module a job needs must be added there too, or the job fails at boot. That is what the `__boot_check__` execution catches.
- **mc-regional vs (default):**
  - Production data is in **mc-regional**.
  - Operator scripts take `--database=mc-regional` and `--auth=gcloud`. The Firestore client libraries reject a gcloud user token, so `scripts/lib/script-firestore.ts` uses a REST shim. Its `batch().set` **replaces** whole docs; use `update` for field changes.
  - `firebase deploy --only firestore:rules` deploys rules to both databases.
- **Strategy Lab engine:** it lives in the UI and a copy in the backend. Keep them in sync with `MarketCatalystUI/scripts/strategy-lab/sync-engine.sh`.
- **Global guard (WIP):**
  - A new controller route **fails `entitlement.guard.spec.ts`** until it is added to `ROUTE_FEATURES` or `PLAN_EXEMPT_ROUTES` in the registry.
  - New public routes must also go into `src/common/route-guards.spec.ts` and `src/api-health/screen-api.registry.ts`.
- **Flaky tests:** a few billing e2e tests flake under full parallel load (timeouts). They pass when run alone; rerun the file before chasing them.
- **Data vendors:**
  - FMP data gaps and the open data-accuracy items: `Doc/DATA-QA-AUDIT-2026-08-17.md`, `Doc/FEATURE-DATA-MAP.md`, `Doc/FMP-INTEGRATION.md`, `Doc/POLYGON-FEATURE-CROSSCHECK.md`.
  - Licensing questions (Polygon individual-use terms, FMP display/redistribution agreement): `Doc/EMAIL-TO-POLYGON.md`, `Doc/EMAIL-TO-FMP.md`, `Doc/MarketCatalyst_Polygon_Data_Redistribution_Requirements.pdf`. **Unresolved; owner decision.**
- **Money Flow:** the PICK rule and card/popover sync are covered by UI tests `tests/ui/money-flow-pick-rule.test.mjs` and `money-flow-card-popover-sync.test.mjs`. Don't change the rule without the owner.
- **Site copy audit:** still open for "Free", "15 workspaces" and abbreviations (E6).
- **Node version:** production uses `node:22-slim` (`Dockerfile`). There is no `.nvmrc` or `engines` pin; add one if you hit differences.
- **FMP key rotation:** `FMP_API_KEY` is a Secret Manager value on both services. Rotate it by adding a version and redeploying (deploy window). Never paste it anywhere.
- **Classifier:** a push to Website `prod` (an App Hosting rollout) can be blocked as a "production deploy". In that case give the owner the command instead.
- **Lint:** the repo-wide lint baseline is large. Compare problem counts on the changed files only. In zsh, expand a file list with `${=VAR}`.

---

## I. Start here (next agent)

```bash
cd ~/MarketCatalyst/MarketCatalystBackEnd && git fetch --all -q && git checkout wip/plans-no-free-feature-groups && npx jest 2>&1 | grep -E "^Tests:"          # expect 1403 passed
npx ts-node --transpile-only scripts/export-catalog.ts --check || echo "copies stale: check out the matching wip branch in UI/Website, then run without --check"
cd ../MarketCatalystUI && git checkout wip/plans-no-free-feature-groups && npm test 2>&1 | grep -E "^ℹ (pass|fail)" && npm run test:rules 2>&1 | grep -E "^ℹ (pass|fail)"   # 405/0 and 129/0
cd ../MarketCatalystWebsite && git checkout wip/plans-no-free-feature-groups && npm test 2>&1 | grep -E "^ℹ (pass|fail)"          # 29/0
TZ=America/New_York date; gcloud run services describe market-catalyst-live --region us-central1 --project market-catalyst-502415 --format="value(status.traffic[0].revisionName)"   # confirm §F is still current
```

**Pick up first:**
1. **E0** (deploy `prod`; needs the owner's OK and a deploy window).
2. **E2 + E5** (the UI side of "no free plan" and the generated map). These complete requirement 8, and E1/E3/E4 build on them.
3. Then E1 → E3 → E4 → E6 → E8.
