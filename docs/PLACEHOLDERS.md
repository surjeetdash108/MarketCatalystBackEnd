# Placeholders

Every value below is a stand-in that must be replaced before paid plans go live. One marker throughout: the value contains `PLACEHOLDER` or is an `example.com` address. `node scripts/check-placeholders.mjs` lists what remains; `--production` exits 1 while any would ship. Add `--cloud-run` to count settings already configured on the Cloud Run services (secret references by name; values are never read).

Generated from the checker's output on 2026-11-10; regenerate the file references if lines move.

## Stripe

| Name | Current placeholder | Real value needed | Where used (file:line) | Secret or config | Environments |
| --- | --- | --- | --- | --- | --- |
| STRIPE_SECRET_KEY | `__PLACEHOLDER__` | Stripe secret key (sk_test_… in staging, sk_live_… in production) | `MarketCatalystBackEnd/.env.example:19` | Secret (Secret Manager: `STRIPE_SECRET_KEY`) | staging, production |
| STRIPE_WEBHOOK_SECRET | `__PLACEHOLDER__` | Signing secret of the webhook endpoint (whsec_…) | `MarketCatalystBackEnd/.env.example:20` | Secret (Secret Manager) | staging, production |
| NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY | `__PLACEHOLDER__` | Publishable key for Stripe.js 3-D Secure (pk_…) | `MarketCatalystUI/.env.example:15` | Plain config (UI build env) | staging, production |
| STRIPE_PORTAL_CONFIGURATION | `bpc_PLACEHOLDER` | Customer Portal configuration id printed by scripts/stripe-seed.ts | `MarketCatalystBackEnd/.env.example:21` | Plain config | staging, production |
| STRIPE_RETENTION_COUPON_ID | `coupon_RETAIN50_2M_PLACEHOLDER` | Retention coupon id (50% off, repeating, 2 months) printed by the seed script | `MarketCatalystBackEnd/.env.example:22` | Plain config | staging, production |
| Price lookup keys / ids | `price_starter_monthly_PLACEHOLDER` … | Real Price ids printed by the seed script; the app resolves Prices by lookup key (starter_monthly … elite_annual from plans.registry), so ids are reference only | `MarketCatalystBackEnd/.env.example:25` | Plain config (reference) | staging, production |
| Webhook URL | — | Register `https://app.marketcatalyst.ai/api/billing/webhook` (staging: the stage host) in Stripe with the events listed in stripe-billing.provider.ts | `MarketCatalystBackEnd/.env.example:23`, `MarketCatalystBackEnd/src/billing/provider/stripe/stripe-billing.provider.ts` (STRIPE_EVENT_MAP) | Stripe dashboard setting | staging, production |
| FAKE_BILLING_WEBHOOK_SECRET | `__PLACEHOLDER__` | Any random string for the fake provider (dev/staging); unset = random per boot | `MarketCatalystBackEnd/.env.example:16` | Secret (staging only) | local, staging |

## Email

| Name | Current placeholder | Real value needed | Where used (file:line) | Secret or config | Environments |
| --- | --- | --- | --- | --- | --- |
| EMAIL_PROVIDER_API_KEY | `__PLACEHOLDER__` | API key of the chosen provider (SendGrid / Postmark / …) once its adapter is wired | `MarketCatalystBackEnd/.env.example:29` | Secret (Secret Manager) | staging, production |
| EMAIL_FROM_NAME | `MarketCatalyst [PLACEHOLDER]` | Sender display name | `MarketCatalystBackEnd/.env.example:30`, `MarketCatalystBackEnd/src/billing/email/email.service.ts:40` | Plain config | staging, production |
| EMAIL_FROM_ADDRESS | `noreply@example.com` | Sending address on a verified domain | `MarketCatalystBackEnd/.env.example:31`, `MarketCatalystBackEnd/src/billing/email/email.service.ts:41` | Plain config | staging, production |
| EMAIL_REPLY_TO | `support@example.com` | Support inbox for replies | `MarketCatalystBackEnd/.env.example:32`, `MarketCatalystBackEnd/src/billing/email/email.service.ts:46` | Plain config | staging, production |
| Launch email subject & copy | `[LAUNCH EMAIL SUBJECT PLACEHOLDER]`, `[LAUNCH EMAIL COPY PLACEHOLDER]` | Final launch-email wording | `MarketCatalystBackEnd/src/billing/email/email.service.ts:263`, `MarketCatalystBackEnd/src/billing/email/email.service.ts:264` | Copy (code) | production |
| Privacy: email provider | `[EMAIL PROVIDER PLACEHOLDER]` | Name of the transactional email processor (Privacy already lists Twilio SendGrid for email delivery — confirm or merge) | `MarketCatalystUI/app/auth/legal/privacy-content.tsx:175`, `MarketCatalystWebsite/components/marketing/PrivacyPolicy.tsx:177` | Copy | production |

## Legal/company

| Name | Current placeholder | Real value needed | Where used (file:line) | Secret or config | Environments |
| --- | --- | --- | --- | --- | --- |
| Contracting entity | `MarketCatalyst LLC [PLACEHOLDER]` | Legal entity name | `MarketCatalystUI/app/auth/legal/terms-content.tsx:200`, `MarketCatalystWebsite/components/marketing/TermsOfService.tsx:202` | Copy | production |
| Registered address | `[ADDRESS PLACEHOLDER]` | Registered address | `MarketCatalystUI/app/auth/legal/terms-content.tsx:200`, `MarketCatalystWebsite/components/marketing/TermsOfService.tsx:202` | Copy | production |
| Support phone | `[PHONE PLACEHOLDER]` | Support phone (or remove) | `MarketCatalystUI/app/auth/legal/terms-content.tsx:200`, `MarketCatalystWebsite/components/marketing/TermsOfService.tsx:202` | Copy | production |
| Support email in Terms | `support@example.com` + `[SUPPORT EMAIL PLACEHOLDER]` | Real support address for cancellations | — | Copy | production |
| Refund/support contact | `[SUPPORT CONTACT PLACEHOLDER]` | How to contest a charge | — | Copy | production |
| Legal review | `[LEGAL REVIEW PLACEHOLDER]`, `[LEGAL REVIEW DATE PLACEHOLDER]` | Counsel approval of Terms §12 / Privacy additions, reviewer and date | `MarketCatalystUI/app/auth/legal/terms-content.tsx:176`, `MarketCatalystWebsite/components/marketing/TermsOfService.tsx:178` | Copy | production |

## Website/app copy

| Name | Current placeholder | Real value needed | Where used (file:line) | Secret or config | Environments |
| --- | --- | --- | --- | --- | --- |
| NEXT_PUBLIC_ADMIN_EMAIL / ADMIN_EMAIL | `admin@example.com` | The admin account (production already sets ADMIN_EMAIL) | `MarketCatalystUI/.env.example:9`, `MarketCatalystBackEnd/.env.example:35`, `MarketCatalystBackEnd/scripts/launch-migration.ts:58` | Plain config | all |

## Other

| Name | Current placeholder | Real value needed | Where used (file:line) | Secret or config | Environments |
| --- | --- | --- | --- | --- | --- |
| LAUNCH_PROMO_PREFIX | `LAUNCH_PLACEHOLDER` | Prefix of the one-time launch codes (e.g. LAUNCH26) | `MarketCatalystBackEnd/.env.example:40`, `MarketCatalystBackEnd/scripts/launch-migration.ts:37` | Plain config | production (migration run) |
| LAUNCH_PROMO_PERCENT | `__PLACEHOLDER__` | Discount of the first-year launch code (whole %) | `MarketCatalystBackEnd/.env.example:41`, `MarketCatalystBackEnd/scripts/launch-migration.ts:38` | Plain config | production (migration run) |
| STREAM_TICKET_SECRET | `__PLACEHOLDER__` | ≥32 random characters, same on every live instance. Added in M0 (before this branch); **already set in production** on market-catalyst-live as a Secret Manager reference (`STREAM_TICKET_SECRET:latest`) — `check-placeholders --production --cloud-run` reports it satisfied | `MarketCatalystBackEnd/.env.example:44` | Secret (Secret Manager) | staging, production (live only) |
| SEC_USER_AGENT | `MarketCatalyst [PLACEHOLDER] contact@example.com` | SEC EDGAR contact string (company + monitored email) | `MarketCatalystBackEnd/.env.example:47` | Plain config | all |

## Full list (check-placeholders output)

- `MarketCatalystBackEnd/src/billing/email/email.service.ts:40` [env-default] const name = this.config.get<string>("EMAIL_FROM_NAME", "MarketCatalyst [PLACEHOLDER]"); // prettier-ignore
- `MarketCatalystBackEnd/src/billing/email/email.service.ts:41` [env-default] const addr = this.config.get<string>("EMAIL_FROM_ADDRESS", "noreply@example.com"); // prettier-ignore
- `MarketCatalystBackEnd/src/billing/email/email.service.ts:46` [env-default] return this.config.get<string>("EMAIL_REPLY_TO", "support@example.com");
- `MarketCatalystBackEnd/src/billing/email/email.service.ts:263` [code-or-copy] return this.send("launch_offer", to, "[LAUNCH EMAIL SUBJECT PLACEHOLDER]", [
- `MarketCatalystBackEnd/src/billing/email/email.service.ts:264` [code-or-copy] "[LAUNCH EMAIL COPY PLACEHOLDER]",
- `MarketCatalystBackEnd/scripts/launch-migration.ts:37` [env-default] const prefix = process.env.LAUNCH_PROMO_PREFIX ?? "LAUNCH_PLACEHOLDER";
- `MarketCatalystBackEnd/scripts/launch-migration.ts:38` [env-default] const percentRaw = process.env.LAUNCH_PROMO_PERCENT ?? "__PLACEHOLDER__";
- `MarketCatalystBackEnd/scripts/launch-migration.ts:58` [env-default] excludeEmails: [process.env.ADMIN_EMAIL ?? "admin@example.com"],
- `MarketCatalystBackEnd/.env.example:3` [env-template] # never in this file or in deploy/*.yaml. Every value containing PLACEHOLDER (or an
- `MarketCatalystBackEnd/.env.example:16` [env-template] FAKE_BILLING_WEBHOOK_SECRET=__PLACEHOLDER__
- `MarketCatalystBackEnd/.env.example:19` [env-template] STRIPE_SECRET_KEY=__PLACEHOLDER__
- `MarketCatalystBackEnd/.env.example:20` [env-template] STRIPE_WEBHOOK_SECRET=__PLACEHOLDER__
- `MarketCatalystBackEnd/.env.example:21` [env-template] STRIPE_PORTAL_CONFIGURATION=bpc_PLACEHOLDER
- `MarketCatalystBackEnd/.env.example:22` [env-template] STRIPE_RETENTION_COUPON_ID=coupon_RETAIN50_2M_PLACEHOLDER
- `MarketCatalystBackEnd/.env.example:25` [env-template] # scripts/stripe-seed.ts for reference: price_starter_monthly_PLACEHOLDER etc.
- `MarketCatalystBackEnd/.env.example:29` [env-template] EMAIL_PROVIDER_API_KEY=__PLACEHOLDER__
- `MarketCatalystBackEnd/.env.example:30` [env-template] EMAIL_FROM_NAME="MarketCatalyst [PLACEHOLDER]"
- `MarketCatalystBackEnd/.env.example:31` [env-template] EMAIL_FROM_ADDRESS=noreply@example.com
- `MarketCatalystBackEnd/.env.example:32` [env-template] EMAIL_REPLY_TO=support@example.com
- `MarketCatalystBackEnd/.env.example:35` [env-template] ADMIN_EMAIL=admin@example.com
- `MarketCatalystBackEnd/.env.example:40` [env-template] LAUNCH_PROMO_PREFIX=LAUNCH_PLACEHOLDER
- `MarketCatalystBackEnd/.env.example:41` [env-template] LAUNCH_PROMO_PERCENT=__PLACEHOLDER__
- `MarketCatalystBackEnd/.env.example:44` [env-template] STREAM_TICKET_SECRET=__PLACEHOLDER__
- `MarketCatalystBackEnd/.env.example:47` [env-template] SEC_USER_AGENT="MarketCatalyst [PLACEHOLDER] contact@example.com"
- `MarketCatalystUI/app/auth/legal/privacy-content.tsx:87` [code-or-copy] <strong>Payment and subscription information:</strong> your plan, billing history, and billing contact details. Payments are processed by our third-party paymen
- `MarketCatalystUI/app/auth/legal/privacy-content.tsx:89` [code-or-copy] <strong>Transactional email:</strong> we send billing emails (receipts, renewal reminders, payment problems, plan changes and cancellation confirmations) throug
- `MarketCatalystUI/app/auth/legal/privacy-content.tsx:175` [code-or-copy] <td>[EMAIL PROVIDER PLACEHOLDER]</td>
- `MarketCatalystUI/app/auth/legal/terms-content.tsx:176` [code-or-copy] <strong>Draft — legal review required.</strong> This section describes how subscriptions work in the Service. [LEGAL REVIEW PLACEHOLDER: to be reviewed and appr
- `MarketCatalystUI/app/auth/legal/terms-content.tsx:184` [code-or-copy] <strong>How to cancel.</strong> Cancel anytime on the Manage Plan page in the app, or by emailing <a href="mailto:support@example.com">support@example.com</a> [
- `MarketCatalystUI/app/auth/legal/terms-content.tsx:188` [code-or-copy] <strong>Refunds.</strong> We do not provide refunds or credits for partial billing periods or unused time, except as required by law or where we decide otherwis
- `MarketCatalystUI/app/auth/legal/terms-content.tsx:200` [code-or-copy] <strong>Who you contract with.</strong> Subscriptions are provided by MarketCatalyst LLC [PLACEHOLDER], [ADDRESS PLACEHOLDER], [PHONE PLACEHOLDER].</li>
- `MarketCatalystUI/.env.example:2` [env-template] # Every value containing PLACEHOLDER (or an example.com address) must be
- `MarketCatalystUI/.env.example:9` [env-template] NEXT_PUBLIC_ADMIN_EMAIL=admin@example.com
- `MarketCatalystUI/.env.example:15` [env-template] NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=__PLACEHOLDER__
- `MarketCatalystWebsite/components/marketing/PrivacyPolicy.tsx:89` [code-or-copy] <strong>Payment and subscription information:</strong> your plan, billing history, and billing contact details. Payments are processed by our third-party paymen
- `MarketCatalystWebsite/components/marketing/PrivacyPolicy.tsx:91` [code-or-copy] <strong>Transactional email:</strong> we send billing emails (receipts, renewal reminders, payment problems, plan changes and cancellation confirmations) throug
- `MarketCatalystWebsite/components/marketing/PrivacyPolicy.tsx:177` [code-or-copy] <td>[EMAIL PROVIDER PLACEHOLDER]</td>
- `MarketCatalystWebsite/components/marketing/TermsOfService.tsx:178` [code-or-copy] <strong>Draft — legal review required.</strong> This section describes how subscriptions work in the Service. [LEGAL REVIEW PLACEHOLDER: to be reviewed and appr
- `MarketCatalystWebsite/components/marketing/TermsOfService.tsx:186` [code-or-copy] <strong>How to cancel.</strong> Cancel anytime on the Manage Plan page in the app, or by emailing <a href="mailto:support@example.com">support@example.com</a> [
- `MarketCatalystWebsite/components/marketing/TermsOfService.tsx:190` [code-or-copy] <strong>Refunds.</strong> We do not provide refunds or credits for partial billing periods or unused time, except as required by law or where we decide otherwis
- `MarketCatalystWebsite/components/marketing/TermsOfService.tsx:202` [code-or-copy] <strong>Who you contract with.</strong> Subscriptions are provided by MarketCatalyst LLC [PLACEHOLDER], [ADDRESS PLACEHOLDER], [PHONE PLACEHOLDER].</li>
