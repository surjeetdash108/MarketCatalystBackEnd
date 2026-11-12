/**
 * Stripe TEST-MODE probe of StripeBillingProvider's plan changes (refuses any
 * key but sk_test_). Creates throwaway customers without a uid, so our webhook
 * ignores them. The key comes from the environment and is never printed.
 *
 *   STRIPE_SECRET_KEY=sk_test_… npx ts-node scripts/stripe-test-mode-plan-change-probe.ts
 */
import Stripe from "stripe";
import { configOf } from "../test/support/billing-harness";
import {
  STRIPE_API_VERSION,
  StripeBillingProvider,
} from "../src/billing/provider/stripe/stripe-billing.provider";
import { catalogPrice } from "../src/plans/plans.registry";

const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!key.startsWith("sk_test_")) {
  console.log("REFUSED: not a test-mode key");
  process.exit(2);
}
const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
const p = new StripeBillingProvider(configOf({ STRIPE_SECRET_KEY: key }), stripe);
const ref = (planId: string, interval: "monthly" | "annual") => ({
  planId,
  interval,
  amount: catalogPrice(planId, interval).amount,
  currency: "USD",
  lookupKey: catalogPrice(planId, interval).lookupKey,
});
const BILLING = {
  name: "Probe Customer",
  address: { line1: "1 Main St", line2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
};
let failures = 0;
const check = (name: string, ok: boolean, detail: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${JSON.stringify(detail)}`);
};
const priceId = async (lk: string) => (await stripe.prices.list({ lookup_keys: [lk], active: true, limit: 1 })).data[0].id;

async function customerWithSub(planId: string, interval: "monthly" | "annual", trialDays = 0) {
  const c = await stripe.customers.create({ description: "plan-change probe (safe to delete)", metadata: { probe: "1" }, name: BILLING.name,
    address: { line1: "1 Main St", city: "Austin", state: "TX", postal_code: "78701", country: "US" } });
  const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: c.id });
  await stripe.customers.update(c.id, { invoice_settings: { default_payment_method: pm.id } });
  const sub = await stripe.subscriptions.create({ customer: c.id, items: [{ price: await priceId(ref(planId, interval).lookupKey) }],
    automatic_tax: { enabled: true }, ...(trialDays ? { trial_period_days: trialDays } : {}), metadata: { planId, interval, probe: "1" } });
  return { c, sub };
}
const newCard = async (customer: string) => {
  // A fresh card as the Payment Element would create it (not yet attached).
  const pm = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_mastercard" } });
  void customer;
  return pm.id;
};

(async () => {
  // 1) Paid upgrade Starter → Pro with the card entered at checkout.
  {
    const { c, sub } = await customerWithSub("starter", "monthly");
    const target = ref("pro", "monthly");
    const prev = await p.previewChange({ subscriptionId: sub.id, target, kind: "upgrade" });
    const used = (prev.alreadyPaid ?? 0) - (prev.unusedCredit ?? 0);
    check("upgrade preview: already paid = Starter price paid this period", prev.alreadyPaid === 3900, { alreadyPaid: prev.alreadyPaid });
    check("upgrade preview: used + new − already paid = amount due (no tax/discount here)",
      used + (prev.newPlanCharge ?? 0) - (prev.alreadyPaid ?? 0) + (prev.tax ?? 0) - (prev.discount ?? 0) - (prev.creditUsed ?? 0) === prev.amountDueNow,
      { used, newPlanCharge: prev.newPlanCharge, alreadyPaid: prev.alreadyPaid, tax: prev.tax, due: prev.amountDueNow });
    const pm = await newCard(c.id);
    const r = await p.changePlan({ subscriptionId: sub.id, target, kind: "upgrade", prorationDate: prev.prorationDate, expectedAmountDue: prev.amountDueNow, paymentMethodId: pm, billing: BILLING });
    const after = await stripe.subscriptions.retrieve(sub.id);
    check("upgrade applied and charged exactly the preview", r.status === "applied" && (r as { amountCharged: number }).amountCharged === prev.amountDueNow, r);
    check("upgrade: Pro price, new card is the subscription's card, metadata updated",
      after.items.data[0].price.lookup_key === "pro_monthly" && after.default_payment_method === pm && after.metadata.planId === "pro",
      { price: after.items.data[0].price.lookup_key, pm: after.default_payment_method === pm, planId: after.metadata.planId });
  }
  // 2) Free trial: monthly → annual keeps the trial; nothing charged now.
  {
    const { c, sub } = await customerWithSub("pro", "monthly", 7);
    const target = ref("pro", "annual");
    const prev = await p.previewChange({ subscriptionId: sub.id, target, kind: "upgrade" });
    check("trial m→a preview: $0 now", prev.amountDueNow === 0, { due: prev.amountDueNow });
    const r = await p.changePlan({ subscriptionId: sub.id, target, kind: "upgrade", prorationDate: prev.prorationDate, expectedAmountDue: 0, paymentMethodId: await newCard(c.id), billing: BILLING });
    const after = await stripe.subscriptions.retrieve(sub.id);
    check("trial m→a: still trialing, same trial end, annual price", r.status === "applied" && after.status === "trialing" && after.trial_end === sub.trial_end && after.items.data[0].price.lookup_key === "pro_annual",
      { status: after.status, sameTrialEnd: after.trial_end === sub.trial_end, price: after.items.data[0].price.lookup_key });
  }
  // 3) Free trial: scheduled change to a lower plan keeps the trial.
  {
    const { c, sub } = await customerWithSub("pro", "monthly", 7);
    const r = await p.changePlan({ subscriptionId: sub.id, target: ref("starter", "monthly"), kind: "scheduled", prorationDate: Date.now(), expectedAmountDue: null, paymentMethodId: await newCard(c.id), billing: BILLING });
    const after = await stripe.subscriptions.retrieve(sub.id, { expand: ["schedule"] });
    check("trial scheduled change: still trialing, same trial end, schedule active", r.status === "scheduled" && after.status === "trialing" && after.trial_end === sub.trial_end && !!after.schedule,
      { status: after.status, sameTrialEnd: after.trial_end === sub.trial_end, effectiveAt: (r as { effectiveAt?: string }).effectiveAt });
    const mapped = await p.getSubscription(sub.id);
    check("trial scheduled change shows as scheduledChange to Starter at trial end", mapped?.scheduledChange?.planId === "starter", mapped?.scheduledChange);
  }
  // 4) Paid: scheduled change (Pro annual → Pro monthly) charges nothing now.
  {
    const { c, sub } = await customerWithSub("pro", "annual");
    const before = (await stripe.invoices.list({ customer: c.id })).data.length;
    const r = await p.changePlan({ subscriptionId: sub.id, target: ref("pro", "monthly"), kind: "scheduled", prorationDate: Date.now(), expectedAmountDue: null, paymentMethodId: await newCard(c.id), billing: BILLING });
    const invoices = (await stripe.invoices.list({ customer: c.id })).data.length;
    check("annual → monthly scheduled; no new invoice now", r.status === "scheduled" && invoices === before, { r, newInvoices: invoices - before });
  }
  // 5) Declined card on an upgrade: plan unchanged.
  {
    const { c, sub } = await customerWithSub("starter", "monthly");
    const target = ref("elite", "monthly");
    const prev = await p.previewChange({ subscriptionId: sub.id, target, kind: "upgrade" });
    const declined = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_chargeCustomerFail" } }).catch(() => null);
    void c;
    if (declined) {
      const r = await p.changePlan({ subscriptionId: sub.id, target, kind: "upgrade", prorationDate: prev.prorationDate, expectedAmountDue: prev.amountDueNow, paymentMethodId: declined.id, billing: BILLING }).catch((e) => ({ status: "error", message: (e as Error).message }));
      const after = await stripe.subscriptions.retrieve(sub.id);
      check("declined upgrade: plan unchanged (still Starter)", after.items.data[0].price.lookup_key === "starter_monthly", { result: r, price: after.items.data[0].price.lookup_key });
    }
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log("PROBE ERROR", (e as Error).message);
  process.exit(1);
});
