/**
 * Creates the Stripe objects the app needs from the catalog — WRITTEN, NOT RUN.
 *
 *   npm install stripe                      # not a dependency until the adapter is built
 *   STRIPE_SECRET_KEY=sk_test_... npx ts-node --transpile-only scripts/stripe-seed.ts [--dry-run]
 *   (live mode additionally needs --live --confirm-live and an sk_live_ key)
 *
 * Creates (idempotently, matched by lookup key / metadata):
 *   - one Product per paid plan (metadata.planId)
 *   - one recurring Price per plan × interval with the catalog lookup key
 *   - the retention coupon (50% off, repeating, 2 months)
 *   - a Customer Portal configuration: payment method update + invoice history only
 * and prints the IDs to put in Secret Manager / env (docs/PLACEHOLDERS.md).
 */
import { stripeSeedPlan } from "../src/billing/provider/stripe/stripe-seed-plan";

async function main() {
  const plan = stripeSeedPlan();
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (process.argv.includes("--dry-run") || !key || key.includes("PLACEHOLDER")) {
    console.log(JSON.stringify(plan, null, 2));
    if (!process.argv.includes("--dry-run")) console.error("STRIPE_SECRET_KEY is missing or a placeholder: printed the plan only.");
    return;
  }
  const live = key.startsWith("sk_live_");
  if (live && !(process.argv.includes("--live") && process.argv.includes("--confirm-live"))) {
    throw new Error("Live key detected: pass --live --confirm-live to seed live mode.");
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Stripe = require("stripe");
  const stripe = new Stripe(key);
  const out: Record<string, string> = {};
  for (const p of plan.products) {
    const found = await stripe.products.search({ query: `metadata['planId']:'${p.planId}'` });
    const product = found.data[0] ?? (await stripe.products.create({ name: p.name, description: p.description, metadata: p.metadata }));
    out[`product_${p.planId}`] = product.id;
    for (const pr of plan.prices.filter((x) => x.planId === p.planId)) {
      const existing = await stripe.prices.list({ lookup_keys: [pr.lookupKey], active: true });
      const price = existing.data[0] ?? (await stripe.prices.create({ product: product.id, unit_amount: pr.unitAmount, currency: pr.currency, recurring: { interval: pr.interval }, lookup_key: pr.lookupKey, transfer_lookup_key: true }));
      if (price.unit_amount !== pr.unitAmount) throw new Error(`${pr.lookupKey} exists at ${price.unit_amount}, catalog says ${pr.unitAmount}: archive it first`);
      out[pr.lookupKey] = price.id;
    }
  }
  const coupon = await stripe.coupons.create({ percent_off: plan.retentionCoupon.percentOff, duration: plan.retentionCoupon.duration, duration_in_months: plan.retentionCoupon.durationInMonths, name: plan.retentionCoupon.name });
  out.STRIPE_RETENTION_COUPON_ID = coupon.id;
  const portal = await stripe.billingPortal.configurations.create({
    business_profile: { headline: "Manage your MarketCatalyst billing" },
    features: { payment_method_update: { enabled: true }, invoice_history: { enabled: true }, subscription_cancel: { enabled: false }, subscription_update: { enabled: false } },
  });
  out.STRIPE_PORTAL_CONFIGURATION = portal.id;
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
