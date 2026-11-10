/**
 * Creates the Stripe objects the app needs from the catalog (idempotent: run it
 * again any time; nothing is duplicated).
 *
 *   STRIPE_SECRET_KEY=sk_test_... STRIPE_PRODUCT_TAX_CODE=txcd_... \
 *     npx ts-node --transpile-only scripts/stripe-seed.ts [--dry-run]
 *   (live mode additionally needs --live --confirm-live and an sk_live_ key)
 *
 * Creates, matched by metadata / lookup key:
 *   - one Product per paid plan (metadata.planId) with the SaaS tax code
 *   - one recurring Price per plan × interval with the catalog lookup key,
 *     tax_behavior "exclusive" (Stripe Tax adds tax on top of the catalog price)
 *   - a Customer Portal configuration: payment method update + invoice history only
 * The retention and promo coupons are created on demand by the provider.
 * Prints STRIPE_PORTAL_CONFIGURATION and the webhook events to register.
 */
import Stripe from "stripe";
import {
  STRIPE_API_VERSION,
  STRIPE_WEBHOOK_EVENTS,
} from "../src/billing/provider/stripe/stripe-billing.provider";
import { stripeSeedPlan } from "../src/billing/provider/stripe/stripe-seed-plan";

async function main() {
  const plan = stripeSeedPlan();
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (
    process.argv.includes("--dry-run") ||
    !key ||
    key.includes("PLACEHOLDER")
  ) {
    console.log(JSON.stringify(plan, null, 2));
    if (!process.argv.includes("--dry-run"))
      console.error(
        "STRIPE_SECRET_KEY is missing or a placeholder: printed the plan only.",
      );
    return;
  }
  const live = key.startsWith("sk_live_");
  if (
    live &&
    !(
      process.argv.includes("--live") && process.argv.includes("--confirm-live")
    )
  ) {
    throw new Error(
      "Live key detected: pass --live --confirm-live to seed live mode.",
    );
  }
  const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
  // Stripe Tax: the product tax code for SaaS (to confirm with tax counsel) and
  // automatic tax; tax registrations (Texas first) are set in the Stripe dashboard.
  const taxCode = process.env.STRIPE_PRODUCT_TAX_CODE ?? "__PLACEHOLDER__";
  if (taxCode.includes("PLACEHOLDER"))
    throw new Error(
      "STRIPE_PRODUCT_TAX_CODE is a placeholder: confirm the SaaS tax code first.",
    );
  const out: Record<string, string> = {};
  for (const p of plan.products) {
    const found = await stripe.products.search({
      query: `metadata['planId']:'${p.planId}'`,
    });
    const product = found.data[0]
      ? await stripe.products.update(found.data[0].id, { tax_code: taxCode })
      : await stripe.products.create({
          name: p.name,
          description: p.description,
          metadata: p.metadata,
          tax_code: taxCode,
        });
    out[`product_${p.planId}`] = product.id;
    for (const pr of plan.prices.filter((x) => x.planId === p.planId)) {
      const existing = await stripe.prices.list({
        lookup_keys: [pr.lookupKey],
        active: true,
      });
      const price =
        existing.data[0] ??
        (await stripe.prices.create({
          product: product.id,
          unit_amount: pr.unitAmount,
          currency: pr.currency,
          recurring: { interval: pr.interval },
          lookup_key: pr.lookupKey,
          transfer_lookup_key: true,
          tax_behavior: "exclusive",
        }));
      if (price.unit_amount !== pr.unitAmount)
        throw new Error(
          `${pr.lookupKey} exists at ${price.unit_amount}, catalog says ${pr.unitAmount}: archive it first`,
        );
      out[pr.lookupKey] = price.id;
    }
  }
  const existingPortal = (
    await stripe.billingPortal.configurations.list({ active: true, limit: 100 })
  ).data.find((c) => c.metadata?.mc === "card-and-invoices");
  const portal =
    existingPortal ??
    (await stripe.billingPortal.configurations.create({
      business_profile: { headline: "Manage your MarketCatalyst billing" },
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        subscription_cancel: { enabled: false },
        subscription_update: { enabled: false },
        customer_update: { enabled: false },
      },
      metadata: { mc: "card-and-invoices" },
    }));
  out.STRIPE_PORTAL_CONFIGURATION = portal.id;
  console.log(
    "Register the webhook endpoint https://app.marketcatalyst.ai/api/billing/webhook with these events:",
  );
  console.log("  " + STRIPE_WEBHOOK_EVENTS.join("\n  "));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
