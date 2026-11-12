/**
 * Stripe TEST-MODE probe: does a retention coupon (50% off, repeating 2 months)
 * on a monthly subscription survive a scheduled plan change, and what does the
 * upcoming invoice show? Refuses non-test keys; throwaway customers, no uid.
 *
 *   STRIPE_SECRET_KEY=sk_test_… npx ts-node --transpile-only scripts/stripe-test-mode-retention-probe.ts
 */
import Stripe from "stripe";
import { configOf } from "../test/support/billing-harness";
import { STRIPE_API_VERSION, StripeBillingProvider } from "../src/billing/provider/stripe/stripe-billing.provider";
import { catalogPrice } from "../src/plans/plans.registry";

const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!key.startsWith("sk_test_")) { console.log("REFUSED: not a test-mode key"); process.exit(2); }
const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
const p = new StripeBillingProvider(configOf({ STRIPE_SECRET_KEY: key }), stripe);
const ref = (planId: string, interval: "monthly" | "annual") => ({ planId, interval, amount: catalogPrice(planId, interval).amount, currency: "USD", lookupKey: catalogPrice(planId, interval).lookupKey });
const priceId = async (lk: string) => (await stripe.prices.list({ lookup_keys: [lk], active: true, limit: 1 })).data[0].id;

(async () => {
  for (const order of ["retention-then-schedule", "schedule-then-retention"] as const) {
    const c = await stripe.customers.create({ description: "retention probe (safe to delete)", metadata: { probe: "1" }, address: { line1: "1 Main St", city: "Austin", state: "TX", postal_code: "78701", country: "US" } });
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: c.id });
    await stripe.customers.update(c.id, { invoice_settings: { default_payment_method: pm.id } });
    const sub = await stripe.subscriptions.create({ customer: c.id, items: [{ price: await priceId("pro_monthly") }], automatic_tax: { enabled: true }, metadata: { planId: "pro", interval: "monthly" } });
    const retention = () => p.applyRetentionDiscount({ subscriptionId: sub.id, customerId: c.id, mode: "percent_next_invoices", percentOff: 50, invoices: 2 });
    const schedule = () => p.changePlan({ subscriptionId: sub.id, target: ref("starter", "monthly"), kind: "scheduled", prorationDate: Date.now(), expectedAmountDue: null });
    if (order === "retention-then-schedule") { await retention(); await schedule(); } else { await schedule(); await retention(); }
    const up = await stripe.invoices.createPreview({ customer: c.id, subscription: sub.id });
    const disc = (up.total_discount_amounts ?? []).reduce((a, d) => a + d.amount, 0);
    const linePrices = up.lines.data.map((l) => `${l.amount} ${l.description}`).join(" | ");
    console.log(`${order}: next invoice subtotal=${up.subtotal} discount=${disc} total=${up.total} due=${up.amount_due} :: ${linePrices}`);
  }
})().catch((e) => { console.log("PROBE ERROR", (e as Error).message); process.exit(1); });
