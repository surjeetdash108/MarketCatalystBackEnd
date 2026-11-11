# Go-live handoff: paid plans

**State today:** the code is complete and deployed to production with `SUBSCRIPTIONS_ENABLED` and `BILLING_PROVIDER` unset, so everyone sees Free / "launching soon".

**What's left:**
1. Fill in the variables below.
2. A Stripe **test-mode** run.
3. Legal review.
4. Switch-on.

Commands assume project `market-catalyst-502415`, region `us-central1`, and you running them from `MarketCatalystBackEnd/`.

> **Secrets never go on a command line, in shell history or in files.** Every secret below is read with `read -rs` (silent, not stored in history) and piped to `gcloud … --data-file=-`.

---

## 0. Staff checkout preview (Stripe TEST mode on production)

Staff-allowlist accounts can run the real purchase flow on production — website tile → sign in → `/checkout` → Stripe card form → success — while `SUBSCRIPTIONS_ENABLED` stays **off** for everyone else. Everyone else keeps "launching soon". Staff keep full access; a preview purchase never removes the staff claim.

Guard rails (enforced in code, tested):
- `CHECKOUT_PREVIEW` flag, default **off**; only verified staff-allowlist accounts are affected.
- Only `sk_test_` / `pk_test_` keys run. A live key (`sk_live_`) stops the backend at startup, and the UI refuses `pk_live_`, unless `STRIPE_LIVE_APPROVED=true` / `NEXT_PUBLIC_STRIPE_LIVE_APPROVED=true` is set. **Do not set either now.**
- Every test-mode record (`customers`, `subscriptions`, `payments`, `subscription_events`, `stripe_events`, `checkout_sessions`, `promo_redemptions`) carries `livemode:false`. These records are excluded from MRR, revenue and subscriber counts, and show a **Test** badge in `/admin/billing`.
- The webhook accepts only events signed with `STRIPE_WEBHOOK_SECRET`. Unsigned or badly signed events get a 400. Events from the other mode are ignored.
- Without Stripe keys, staff still get steps 1–2 (plan, interval, summary, promo, address, phone, consent). The card area says "Payment provider not connected" and Complete purchase stays disabled.

### 0.1 Get the Stripe TEST keys

1. Go to <https://dashboard.stripe.com> and switch **Test mode** on (top right). Everything below happens in test mode.
2. **Developers → API keys:**
   - **Publishable key:** copy the `pk_test_…` value.
   - **Secret key:** click **Reveal test key** and copy the `sk_test_…` value. Don't paste it anywhere except the `read -rs` prompt below.
3. **Developers → Webhooks → Add endpoint:**
   - Endpoint URL: `https://app.marketcatalyst.ai/api/billing/webhook`.
   - Events (`STRIPE_EVENT_MAP` lists these, and the seed prints the same list): `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.upcoming`, `charge.refunded`, `charge.dispute.created`.
   - Save, then **Signing secret → Reveal** and copy the `whsec_…` value.
4. Do the test-mode dashboard settings in section 2 (Stripe Tax with a Texas registration, payment methods Card + Link, customer emails off).

### 0.2 Store the secrets and point production at Stripe test mode

Paste the `put_secret` helper from section 1 first, then:

```bash
P=market-catalyst-502415
put_secret STRIPE_SECRET_KEY          # paste sk_test_…, Enter (silent)
put_secret STRIPE_WEBHOOK_SECRET      # paste whsec_…, Enter (silent)

for S in market-catalyst-live market-catalyst-backend; do
  gcloud run services update $S --region us-central1 --project $P \
    --update-env-vars BILLING_PROVIDER=stripe,STRIPE_PAYMENT_METHOD_TYPES=card,link \
    --update-secrets STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest
done
gcloud run services update market-catalyst-live --region us-central1 --project $P \
  --update-secrets STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest
# After the seed (0.3), add: --update-env-vars STRIPE_PORTAL_CONFIGURATION=bpc_FROM_SEED
```

Do **not** set `SUBSCRIPTIONS_ENABLED` or `STRIPE_LIVE_APPROVED`. Run this outside market hours, like any backend change. Each `services update` creates a new revision. To roll back, run `gcloud run services update-traffic <service> --to-revisions <previous>=100`.

UI: the publishable key is public, but it is compiled in at build time:

```bash
cd ../MarketCatalystUI
printf 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=%s\nNEXT_PUBLIC_STRIPE_PAYMENT_METHOD_TYPES=card,link\n' 'pk_test_PASTE' >> .env.production.local   # gitignored
npm run build && firebase deploy --only hosting --project market-catalyst-502415
```

### 0.3 Seed Stripe (test mode), then go-live-check (test mode)

```bash
cd ../MarketCatalystBackEnd
read -rs STRIPE_SECRET_KEY; export STRIPE_SECRET_KEY        # paste sk_test_…, Enter
export STRIPE_PRODUCT_TAX_CODE=txcd_…  APP_URL=https://app.marketcatalyst.ai
npx ts-node --transpile-only scripts/stripe-seed.ts         # products, prices, portal; prints STRIPE_PORTAL_CONFIGURATION
read -rs STRIPE_WEBHOOK_SECRET; export STRIPE_WEBHOOK_SECRET  # paste whsec_…, Enter
npm run go-live-check -- --mode=test                         # read-only; never prints values
unset STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET
```

Set the printed `bpc_…` on the live service (see the comment in 0.2).

### 0.4 Turn the preview on (and off)

There is no deploy. The flag lives in Firestore `feature_flags/default`, and the services pick it up within 15 s.

```bash
gcloud run services proxy market-catalyst-backend --region us-central1 --project market-catalyst-502415 --port 8080
```

Open <http://localhost:8080>, then go to **Feature flags → "Checkout preview (staff only, test mode)" (`CHECKOUT_PREVIEW`)** and click the toggle to turn it **ON**. Click it again to turn it off.

### 0.5 Walkthrough (staff account)

1. Sign in at <https://app.marketcatalyst.ai> with a staff-allowlist account. A Google account works; an email/password account must be verified.
2. Open <https://marketcatalyst.ai>, then go to **Pricing** and click the **Pro** tile. You land on `/checkout?plan=pro&interval=annual`, with the banner **"Preview: test mode, no real charges"** on every step.
3. Step 1: pick the plan and interval, then **Continue**.
4. Step 2:
   - The summary card shows the price, with tax from Stripe once the address is in.
   - Add a promo (optional), the billing address (Stripe Address Element) and a mobile number.
   - Tick the renewal consent.
5. In the **Stripe Payment Element**, enter card `4242 4242 4242 4242`, any future expiry, any CVC and any ZIP. Click **Complete purchase**. The `/billing/success` page appears once the webhook marks the plan active.
6. Decline: repeat with `4000 0000 0000 0002`. You see "Your card was declined." and stay on the page; nothing is activated.
7. 3-D Secure: repeat with `4000 0025 0000 3155`. Complete the challenge in the Stripe modal and you reach the success page. Fail the challenge and you get an error with no activation.
8. **Manage Plan** now shows the plan picker for this staff account. Upgrades and downgrades also run in test mode.
9. In `/admin/billing` (admin account), the purchase shows a **Test** badge and is not in MRR or subscriber counts.
10. Signed out, or with a non-staff account, `/checkout` and Manage Plan still say "launching soon".

### 0.6 Clean up test data

```bash
npm run purge-test-billing -- --project=market-catalyst-502415 --database=mc-regional --auth=gcloud                                       # dry run: counts only
npm run purge-test-billing -- --project=market-catalyst-502415 --database=mc-regional --auth=gcloud --apply --confirm-production       # delete
```

The script deletes only `livemode:false` records, and resets the billing fields on those users' docs to Free. Stripe's own test objects are cleared under Developers → **Delete all test data** in the dashboard.

---

## 1. Variables

Runtime service accounts:
- live: `741318166823-compute@developer.gserviceaccount.com`;
- worker: `backend-runtime@market-catalyst-502415.iam.gserviceaccount.com`.

### One-time helper for secrets

Paste this into your shell once. It creates the secret if needed, adds a version from stdin, and grants both service accounts access.

```bash
P=market-catalyst-502415
put_secret() {  # usage: put_secret NAME   (then paste the value, press Enter)
  gcloud secrets describe "$1" --project $P >/dev/null 2>&1 || gcloud secrets create "$1" --replication-policy=automatic --project $P
  read -rs V; printf %s "$V" | gcloud secrets versions add "$1" --data-file=- --project $P; unset V
  for SA in 741318166823-compute@developer.gserviceaccount.com backend-runtime@$P.iam.gserviceaccount.com; do
    gcloud secrets add-iam-policy-binding "$1" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --project $P >/dev/null
  done
}
```

| Name | Secret or plain | Where it goes | Where to get it | Command to set it |
|---|---|---|---|---|
| `STRIPE_LIVE_APPROVED` | plain | live + worker | leave **unset** until live payments are approved; `true` allows `sk_live_` keys (the backend refuses them otherwise) | `--update-env-vars STRIPE_LIVE_APPROVED=true` at launch only |
| `NEXT_PUBLIC_STRIPE_LIVE_APPROVED` | plain | UI build | same, for `pk_live_` in the UI | `.env.production.local` at launch only |
| `STRIPE_SECRET_KEY` | **secret** | live + worker | Stripe Dashboard → Developers → API keys → Secret key (`sk_test_…` first, `sk_live_…` at launch) | `put_secret STRIPE_SECRET_KEY` |
| `STRIPE_WEBHOOK_SECRET` | **secret** | live | Dashboard → Developers → Webhooks → your endpoint → Signing secret (`whsec_…`) | `put_secret STRIPE_WEBHOOK_SECRET` |
| `EMAIL_PROVIDER_API_KEY` | **secret** | live + worker | SendGrid → Settings → API Keys → Create (Restricted: **Mail Send** only) | `put_secret EMAIL_PROVIDER_API_KEY` |
| `BILLING_PROVIDER` | plain | live + worker | the value `stripe` | step 7 of the order below; **not before** |
| `STRIPE_PORTAL_CONFIGURATION` | plain | live | printed by `scripts/stripe-seed.ts` (`bpc_…`) | in the env command below |
| `STRIPE_PAYMENT_METHOD_TYPES` | plain | live + worker | `card,link` (add `,paypal` only if Dashboard → Settings → Payment methods shows PayPal available) | in the env command below |
| `EMAIL_PROVIDER` | plain | live + worker | the value `sendgrid` | in the env command below |
| `EMAIL_FROM_NAME` | plain | live + worker | e.g. `MarketCatalyst` | in the env command below |
| `EMAIL_FROM_ADDRESS` | plain | live + worker | a sender on your SendGrid-authenticated domain, e.g. `billing@marketcatalyst.ai` | in the env command below |
| `EMAIL_REPLY_TO` | plain | live + worker | your support inbox | in the env command below |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | plain (public) | UI build (`MarketCatalystUI/.env.production.local`) | Dashboard → Developers → API keys → Publishable key (`pk_test_…` / `pk_live_…`) | `echo 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_…' >> MarketCatalystUI/.env.production.local` (gitignored), then rebuild and deploy the UI |
| `NEXT_PUBLIC_STRIPE_PAYMENT_METHOD_TYPES` | plain | UI build | same list as `STRIPE_PAYMENT_METHOD_TYPES` | same file as above |
| `STRIPE_PRODUCT_TAX_CODE` | plain | your shell, when running the seed script | Stripe tax codes list, the SaaS code your accountant confirms (`txcd_…`) | `export STRIPE_PRODUCT_TAX_CODE=txcd_…` before `scripts/stripe-seed.ts` |
| `LAUNCH_PROMO_PREFIX`, `LAUNCH_PROMO_PERCENT` | plain | your shell, when running the launch migration | your launch offer | `export …` before `scripts/launch-migration.ts` |
| `STREAM_TICKET_SECRET` | secret | live | **already set** | — |

Plain env on both services (merges into the existing env; never use `--set-env-vars`, which replaces everything):

```bash
for S in market-catalyst-live market-catalyst-backend; do
  gcloud run services update $S --region us-central1 --project $P \
    --update-env-vars EMAIL_PROVIDER=sendgrid,EMAIL_FROM_NAME=MarketCatalyst,EMAIL_FROM_ADDRESS=billing@YOUR-DOMAIN,EMAIL_REPLY_TO=support@YOUR-DOMAIN,STRIPE_PAYMENT_METHOD_TYPES=card,link \
    --update-secrets EMAIL_PROVIDER_API_KEY=EMAIL_PROVIDER_API_KEY:latest,STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest
done
gcloud run services update market-catalyst-live --region us-central1 --project $P \
  --update-env-vars STRIPE_PORTAL_CONFIGURATION=bpc_FROM_SEED \
  --update-secrets STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest
```

The jobs use the worker's code but not the billing settings, so nothing needs setting on them.

---

## 2. Stripe dashboard (test mode first)

Toggle **Test mode** on (top right) for everything below. Repeat it in live mode at step 7 of the order.

1. **Business details:** Settings → Business → public details, statement descriptor `MARKETCATALYST`, support email and phone.
2. **Stripe Tax:**
   - Settings → Tax → turn on, and set your origin (head-office) address.
   - Registrations → **Add registration → United States → Texas** (add other states as nexus requires).
   - Default tax behaviour: **Exclusive** (the seed script also sets it per price).
3. **Product tax code:** confirm the SaaS code with your accountant, then `export STRIPE_PRODUCT_TAX_CODE=txcd_…`. The seed script sets it on every product.
4. **Payment methods:** Settings → Payment methods.
   - Turn on Card and Link. Apple Pay and Google Pay come with Card.
   - Turn on PayPal only if it's offered and you want it, then add it to both payment-method-type variables.
   - Leave crypto and UPI off.
5. **Customer emails:** Settings → Emails → turn **off** "Successful payments" and "Refunds". Receipts and refund emails come from our SendGrid sender, so customers would otherwise get two.
6. **Customer Portal:** created by the seed script (card update and invoice history only; cancelling and plan changes stay in our app so the retention offer runs).
7. **Webhook:** Developers → Webhooks → **Add endpoint**.
   - URL: `https://app.marketcatalyst.ai/api/billing/webhook`
   - Events (the seed script prints the same list): `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.upcoming`, `charge.refunded`, `charge.dispute.created`.
   - Copy the signing secret → `put_secret STRIPE_WEBHOOK_SECRET`.
8. **Apple Pay / Google Pay domain:** the seed script registers `app.marketcatalyst.ai` (Settings → Payment method domains shows it).

**Seed** (test mode, idempotent, safe to re-run):

```bash
read -rs STRIPE_SECRET_KEY; export STRIPE_SECRET_KEY        # paste sk_test_…, Enter
export STRIPE_PRODUCT_TAX_CODE=txcd_…  APP_URL=https://app.marketcatalyst.ai
npx ts-node --transpile-only scripts/stripe-seed.ts            # prints STRIPE_PORTAL_CONFIGURATION + webhook events
unset STRIPE_SECRET_KEY
```

## 3. SendGrid

1. **Settings → Sender Authentication → Authenticate Your Domain:** add the CNAME records it gives you (SPF/DKIM) at your DNS host for the sending domain (e.g. `marketcatalyst.ai`), then click Verify. Also set up a DMARC record (`_dmarc` TXT, starting at `p=none`).
2. **Sender identity:** use an address on that domain for `EMAIL_FROM_ADDRESS` (e.g. `billing@…`). No single-sender verification is needed once the domain is authenticated.
3. **API key:** Settings → API Keys → Create → **Restricted Access → Mail Send: Full Access**, nothing else. Then `put_secret EMAIL_PROVIDER_API_KEY`.
4. **Recommended:** turn off click tracking (the app also disables it per message).

---

## 4. Order to go live

1. **Fill the test-mode variables in staging.** The `market-catalyst-stage` project has no Cloud Run services and your account can't reach its Firestore, so "staging" is the local stack:
   - Backend with `BILLING_PROVIDER=stripe`, the test keys, `EMAIL_PROVIDER=sendgrid` and `SUBSCRIPTIONS_ENABLED=true`, against the Firebase emulators.
   - The UI dev server with `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…`.
   - `stripe listen --forward-to localhost:4400/api/billing/webhook`. The CLI prints a `whsec_…` to use as `STRIPE_WEBHOOK_SECRET` locally.

   A real staging project is optional: enable Cloud Run there and deploy with `deploy/env.stage.yaml`.
2. **Stripe seed (test):** see section 2.
3. **Go-live check (test):** `npx ts-node --transpile-only scripts/go-live-check.ts --mode=test --email=you@YOUR-DOMAIN --secrets-from-gcloud`. Every line must be PASS.
4. **Staging walkthrough with Stripe test cards.** I run it and fix anything that breaks:
   - `4242 4242 4242 4242` succeeds;
   - `4000 0000 0000 0002` is declined;
   - `4000 0025 0000 3155` triggers 3-D Secure;
   - upgrade, downgrade, cancel, retention offer and refund;
   - a renewal using a Stripe test clock.
5. **Legal:** fill the placeholders (entity, address, phone, support email, refund contact, legal review in Terms §12 and Privacy, UI and Website). Counsel reviews. `node scripts/check-placeholders.mjs --production --cloud-run` should then only list the variables above.
6. **Admin hardening:** verify `admin@marketcatalyst.ai`'s email and enrol MFA (Firebase Auth → TOTP), then remove the overrides:
   ```bash
   for S in market-catalyst-live market-catalyst-backend; do gcloud run services update $S --region us-central1 --project $P --remove-env-vars ADMIN_REQUIRE_MFA,ADMIN_REQUIRE_EMAIL_VERIFIED; done
   ```
7. **Live keys, live seed, live webhook:** repeat section 2 in live mode (`sk_live_…`, `pk_live_…`, live webhook signing secret). `put_secret` adds new versions, and services pick up `:latest` on their next revision. Then set `BILLING_PROVIDER=stripe` with `--update-env-vars` on both services, and rebuild and deploy the UI with `pk_live_…`.
8. **Go-live check in production:** `scripts/go-live-check.ts --mode=live --email=… --secrets-from-gcloud`. Everything must be PASS.
9. **Launch migration:**
   - Who gets what: legacy Pro users get 90 days of Pro; other non-paying users get 30 days plus a first-year code; staff and the admin are excluded.
   - Set the offer: `export LAUNCH_PROMO_PREFIX=… LAUNCH_PROMO_PERCENT=…`.
   - Run it: `npx ts-node --transpile-only scripts/launch-migration.ts --project=$P --database=mc-regional`. That's a dry run; add `--apply --confirm-production [--send-emails]` to write.
10. **Switch on:** Admin console → Feature flags → `SUBSCRIPTIONS_ENABLED` = on. No deploy is needed; switching it off is instant.

---

## 5. Manual signed-in production smoke check

Sign in with one of the staff accounts (Google, or a verified email/password account):

- [ ] **Dashboard** loads with no lock cards and no "launching soon" banner. The Insider, Analyst Actions and Portfolio widgets show data.
- [ ] **Stock Intelligence:** open a ticker; the charts, ratings and peers load.
- [ ] **Money Flow** loads (Pro feature) with no lock.
- [ ] **Options flow** loads.
- [ ] **Earnings Hub:** the calendar and announcements load.
- [ ] **Strategy Lab:** run a backtest; the default period shows **1Y**, and results appear.
- [ ] **Manage Plan** shows "Staff access" (no plans, no checkout).
- [ ] **Admin billing page** (`/admin/billing`, admin account): subscribers load; the staff account shows a **Staff** badge; legacy users show **Legacy Pro**; the Staff tab lists the 3 addresses.
- [ ] **Network tab:** no 403 responses on any page above.

## Rollback

`deploy-rollback.md` holds the previous revisions, images, rulesets and builds. `scripts/rollback.sh` prints the restore commands (`--execute` runs them; tokens are never printed).
