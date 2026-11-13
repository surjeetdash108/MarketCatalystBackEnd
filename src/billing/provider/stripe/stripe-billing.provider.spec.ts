import Stripe from "stripe";
import { configOf } from "../../../../test/support/billing-harness";
import {
  InvalidEventSignatureError,
  PreviewStaleError,
} from "../billing-provider";
import {
  STRIPE_WEBHOOK_EVENTS,
  StripeBillingProvider,
} from "./stripe-billing.provider";

/**
 * StripeBillingProvider against a mocked Stripe client (no network, no keys).
 * Webhook signatures use the SDK's real signing helpers.
 */
const WHSEC = "whsec_test_secret";
const real = new Stripe("sk_test_dummy", { apiVersion: "2025-08-27.basil" });
const T = 1_793_000_000; // seconds

function priceObj(lookup: string, id = `price_${lookup}`, amount = 5900) {
  return { id, lookup_key: lookup, unit_amount: amount, currency: "usd" };
}
function subObj(over: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    created: T,
    start_date: T,
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    schedule: null,
    pending_update: null,
    discounts: [],
    metadata: { uid: "u1", planId: "pro", interval: "monthly" },
    items: {
      data: [
        {
          id: "si_1",
          price: priceObj("pro_monthly"),
          current_period_start: T,
          current_period_end: T + 30 * 86400,
        },
      ],
    },
    latest_invoice: {
      id: "in_1",
      amount_paid: 5900,
      amount_due: 5900,
      currency: "usd",
      total_taxes: [],
      confirmation_secret: { client_secret: "pi_secret_1" },
      status: "paid",
    },
    ...over,
  };
}

const SETI: Record<string, unknown> & { metadata: Record<string, string> } = {
  id: "seti_1", object: "setup_intent", status: "succeeded", customer: "cus_1", client_secret: "seti_1_secret_x",
  payment_method: "pm_card_1", created: 0,
  metadata: { uid: "u1", planId: "pro", interval: "monthly", lookupKey: "pro_monthly", trialDays: "7", coupon: "", currency: "USD" },
};

function mockClient(customerSubs: Array<Record<string, unknown>> = [], customerSetups: Array<Record<string, unknown>> = []) {
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string, ret: unknown) =>
    jest.fn((...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return Promise.resolve(
        typeof ret === "function"
          ? (ret as (...a: unknown[]) => unknown)(...args)
          : ret,
      );
    });
  const client = {
    webhooks: real.webhooks,
    prices: {
      list: rec("prices.list", (p: { lookup_keys: string[] }) => ({
        data: [priceObj(p.lookup_keys[0])],
      })),
      retrieve: rec("prices.retrieve", (id: string) =>
        priceObj(id.replace("price_", ""), id),
      ),
    },
    customers: {
      create: rec("customers.create", { id: "cus_1" }),
      update: rec("customers.update", {}),
      createBalanceTransaction: rec("customers.createBalanceTransaction", {}),
    },
    paymentMethods: {
      attach: rec("paymentMethods.attach", (id: string) => ({ id })),
    },
    setupIntents: {
      create: rec("setupIntents.create", (p: { customer: string; metadata: Record<string, string> }) => ({
        id: "seti_1", object: "setup_intent", status: "requires_payment_method", customer: p.customer,
        client_secret: "seti_1_secret_x", metadata: p.metadata, created: T, payment_method: null,
      })),
      retrieve: rec("setupIntents.retrieve", () => ({ ...SETI })),
      update: rec("setupIntents.update", (id: string, p: { metadata: Record<string, string> }) => {
        SETI.metadata = p.metadata;
        return { ...SETI, id };
      }),
      cancel: rec("setupIntents.cancel", {}),
      list: jest.fn(() => (async function* () { for (const x of customerSetups) yield x; })()),
    },
    coupons: {
      retrieve: jest.fn(() =>
        Promise.reject(
          Object.assign(new Error("No such coupon"), { statusCode: 404 }),
        ),
      ),
      create: rec("coupons.create", (p: { id: string }) => ({ id: p.id })),
    },
    subscriptions: {
      create: rec("subscriptions.create", () =>
        subObj({
          status: "incomplete",
          latest_invoice: {
            id: "in_1",
            amount_due: 6387,
            amount_paid: 0,
            currency: "usd",
            total_taxes: [{ amount: 487 }],
            confirmation_secret: { client_secret: "pi_secret_1" },
          },
        }),
      ),
      retrieve: rec("subscriptions.retrieve", () => subObj()),
      update: rec("subscriptions.update", () => subObj()),
      cancel: rec("subscriptions.cancel", {}),
      list: jest.fn((params?: { customer?: string; status?: string }) =>
        (async function* () {
          if (params?.customer) {
            // A customer's own subscriptions (duplicate checks); none unless a test adds some.
            for (const s of customerSubs) if (!params.status || params.status === "all" || s.status === params.status) yield s;
            return;
          }
          yield subObj();
          yield subObj({ id: "sub_dead", status: "canceled" });
        })(),
      ),
    },
    subscriptionSchedules: {
      create: rec("subscriptionSchedules.create", { id: "sub_sched_1" }),
      update: rec("subscriptionSchedules.update", {}),
      release: rec("subscriptionSchedules.release", {}),
      retrieve: rec("subscriptionSchedules.retrieve", {}),
    },
    invoices: {
      createPreview: rec("invoices.createPreview", {
        currency: "usd",
        subtotal: 5900,
        total: 5748,
        amount_due: 5748,
        total_taxes: [{ amount: 438 }],
        total_discount_amounts: [{ amount: 590 }],
        lines: { data: [] },
      }),
      retrieve: rec("invoices.retrieve", {
        id: "in_1",
        parent: {
          subscription_details: {
            subscription: "sub_1",
            metadata: { uid: "u1" },
          },
        },
        lines: { data: [] },
        currency: "usd",
      }),
      update: rec("invoices.update", {}),
    },
    invoicePayments: {
      list: rec("invoicePayments.list", {
        data: [{ invoice: "in_1", payment: { payment_intent: "pi_1" } }],
      }),
    },
    refunds: { create: rec("refunds.create", { id: "re_1" }) },
    billingPortal: {
      sessions: {
        create: rec("portal.create", {
          url: "https://billing.stripe.example/session",
        }),
      },
    },
    promotionCodes: {
      create: rec("promotionCodes.create", { id: "promo_1" }),
      update: rec("promotionCodes.update", {}),
    },
  };
  return { client: client as unknown as Stripe, calls, raw: client };
}

const provider = (env: Record<string, string> = {}, m = mockClient()) => ({
  p: new StripeBillingProvider(
    configOf({ STRIPE_WEBHOOK_SECRET: WHSEC, ...env }),
    m.client,
  ),
  m,
});
const PRO_M = {
  planId: "pro",
  interval: "monthly" as const,
  amount: 5900,
  currency: "USD",
  lookupKey: "pro_monthly",
};
const ELITE_M = {
  planId: "elite",
  interval: "monthly" as const,
  amount: 19900,
  currency: "USD",
  lookupKey: "elite_monthly",
};
const STARTER_M = {
  planId: "starter",
  interval: "monthly" as const,
  amount: 3900,
  currency: "USD",
  lookupKey: "starter_monthly",
};

function signed(event: object) {
  const payload = JSON.stringify(event);
  return {
    payload,
    header: real.webhooks.generateTestHeaderString({ payload, secret: WHSEC }),
  };
}

describe("StripeBillingProvider — embedded checkout", () => {
  it("free trial is card-first: checkout saves the card with a SetupIntent (no subscription, nothing charged yet)", async () => {
    const { p, m } = provider();
    const s1 = await p.createCheckout({ uid: "u1", customerId: "cus_1", price: PRO_M, discount: null, successUrl: "s/{CHECKOUT_SESSION_ID}", cancelUrl: "c", idempotencyKey: "k1", trialDays: 7 });
    expect(m.calls["setupIntents.create"][0][0]).toMatchObject({ customer: "cus_1", usage: "off_session", metadata: { uid: "u1", planId: "pro", lookupKey: "pro_monthly", trialDays: "7" } });
    expect(m.calls["subscriptions.create"] ?? []).toEqual([]);
    expect(s1).toMatchObject({ id: "seti_1", status: "open", amountDueToday: 0, clientSecret: "seti_1_secret_x", subscriptionId: null, successUrl: "s/seti_1" });
    await p.createCheckout({ uid: "u1", customerId: "cus_1", price: STARTER_M, discount: null, successUrl: "s", cancelUrl: "c", idempotencyKey: "k2" });
    const [noTrial] = m.calls["subscriptions.create"].at(-1) as [Record<string, unknown>];
    expect(noTrial.trial_period_days).toBeUndefined();
  });

  it("once the card is saved, the trial subscription starts with that card (idempotent; cancels at trial end if the card is removed)", async () => {
    SETI.metadata = { uid: "u1", planId: "pro", interval: "monthly", lookupKey: "pro_monthly", trialDays: "7", coupon: "", currency: "USD" };
    const { p, m } = provider();
    const s1 = await p.getCheckout("seti_1");
    const [args, opts] = m.calls["subscriptions.create"].at(-1) as [Record<string, unknown>, Record<string, unknown>];
    expect(args).toMatchObject({
      customer: "cus_1",
      default_payment_method: "pm_card_1",
      trial_period_days: 7,
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
      metadata: { uid: "u1", planId: "pro", setupIntentId: "seti_1" },
    });
    expect(opts).toEqual({ idempotencyKey: "trial-seti_1" });
    expect(s1).toMatchObject({ status: "complete", subscriptionId: expect.any(String) });
    const before = m.calls["subscriptions.create"].length;
    await p.getCheckout("seti_1"); // already started: no second subscription
    expect(m.calls["subscriptions.create"].length).toBe(before);
  });

  it("never a second subscription: a saved trial card doesn't start a trial when the customer already has one", async () => {
    SETI.metadata = { uid: "u1", planId: "pro", interval: "monthly", lookupKey: "pro_monthly", trialDays: "7", coupon: "", currency: "USD" };
    const { p, m } = provider({}, mockClient([subObj({ id: "sub_other", status: "active" })]));
    const s = await p.getCheckout("seti_1");
    expect(m.calls["subscriptions.create"] ?? []).toEqual([]);
    expect(s).toMatchObject({ status: "expired", subscriptionId: null });
    expect(m.calls["setupIntents.update"].at(-1)).toEqual(["seti_1", { metadata: expect.objectContaining({ blocked: "already_subscribed" }) }]);
  });

  it("live subscriptions come from Stripe; other unfinished checkouts are closed, the new one kept", async () => {
    const subs = [subObj({ id: "sub_live", status: "trialing" }), subObj({ id: "sub_inc_old", status: "incomplete" }), subObj({ id: "sub_inc_new", status: "incomplete" }), subObj({ id: "sub_gone", status: "canceled" })];
    const setups = [
      { id: "seti_old", status: "requires_payment_method", metadata: { planId: "pro" } },
      { id: "seti_done", status: "succeeded", metadata: { planId: "pro" } },
      { id: "seti_other", status: "requires_payment_method", metadata: {} },
    ];
    const { p, m } = provider({}, mockClient(subs, setups));
    expect(await p.liveSubscriptionIds("cus_1")).toEqual(["sub_live"]);
    await p.closeOtherCheckouts("cus_1", "sub_inc_new");
    expect(m.calls["subscriptions.cancel"]).toEqual([["sub_inc_old"]]);
    expect(m.calls["setupIntents.cancel"]).toEqual([["seti_old"]]);
  });

  it("webhook: setup_intent.succeeded for a trial is 'card saved'; other setup intents are ignored", async () => {
    const { p } = provider();
    const ev = (object: object) => ({ id: "evt_si", object: "event", type: "setup_intent.succeeded", created: T, livemode: false, data: { object } });
    const ours = signed(ev({ ...SETI, metadata: { planId: "pro", uid: "u1" } }));
    expect(await p.parseEvent(ours.payload, ours.header)).toMatchObject({ type: "checkout.card_saved", data: { checkoutSessionId: "seti_1", uid: "u1" } });
    const other = signed(ev({ ...SETI, metadata: {} }));
    expect(await p.parseEvent(other.payload, other.header)).toBeNull();
  });

  it("creates an incomplete subscription with automatic tax, the address on the customer, and returns the confirmation secret", async () => {
    const { p, m } = provider();
    const s = await p.createCheckout({
      uid: "u1",
      customerId: "cus_1",
      price: PRO_M,
      discount: {
        source: "promo",
        code: "SAVE10",
        percentOff: 10,
        duration: "once",
      },
      successUrl:
        "https://app.example.com/billing/success?session={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://app.example.com/manage-plan",
      idempotencyKey: "k1",
      billing: {
        name: "Tex",
        address: {
          line1: "500 Congress Ave",
          line2: null,
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
        },
      },
    });
    expect(m.calls["customers.update"][0]).toEqual([
      "cus_1",
      {
        name: "Tex",
        address: {
          line1: "500 Congress Ave",
          line2: undefined,
          city: "Austin",
          state: "TX",
          postal_code: "78701",
          country: "US",
        },
      },
    ]);
    const [params, opts] = m.calls["subscriptions.create"][0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(params).toMatchObject({
      customer: "cus_1",
      items: [{ price: "price_pro_monthly" }],
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription",
        payment_method_types: ["card"],
      },
      automatic_tax: { enabled: true },
      metadata: { uid: "u1", planId: "pro", interval: "monthly" },
      expand: ["latest_invoice.confirmation_secret"],
    });
    expect((params.discounts as Array<{ coupon: string }>)[0].coupon).toMatch(
      /^mc_promo_[0-9a-f]{16}$/,
    );
    expect(opts).toEqual({ idempotencyKey: "checkout-k1" });
    expect(s).toMatchObject({
      id: "sub_1",
      subscriptionId: "sub_1",
      status: "open",
      clientSecret: "pi_secret_1",
      amountDueToday: 6387,
      tax: 487,
      currency: "USD",
    });
    expect(s.successUrl).toBe(
      "https://app.example.com/billing/success?session=sub_1",
    );
  });

  it("payment method types come from config (default card); Link, crypto and UPI are never allowed", async () => {
    const { p, m } = provider({
      STRIPE_PAYMENT_METHOD_TYPES: "card,link,paypal,crypto,upi",
    });
    await p.createCheckout({
      uid: "u1",
      customerId: "cus_1",
      price: PRO_M,
      discount: null,
      successUrl: "",
      cancelUrl: "",
      idempotencyKey: "k2",
    });
    expect(
      (
        m.calls["subscriptions.create"][0] as [
          { payment_settings: { payment_method_types: string[] } },
        ]
      )[0].payment_settings.payment_method_types,
    ).toEqual(["card", "paypal"]); // never Link (asks for a phone)
  });

  it("tax preview: Stripe Tax for the billing region; subtotal/discount/tax/total from the preview invoice", async () => {
    const { p, m } = provider();
    const q = await p.previewCheckout({
      price: PRO_M,
      discount: null,
      region: { country: "US", state: "TX", postalCode: "78701" },
    });
    expect(m.calls["invoices.createPreview"][0][0]).toMatchObject({
      automatic_tax: { enabled: true },
      customer_details: {
        address: { country: "US", state: "TX", postal_code: "78701" },
      },
      subscription_details: { items: [{ price: "price_pro_monthly" }] },
    });
    expect(q).toEqual({
      currency: "USD",
      subtotal: 5900,
      discount: 590,
      tax: 438,
      total: 5748,
      taxLabel: "Sales tax",
      taxPending: false,
    });
  });

  it("getCheckout reports complete once the subscription is active", async () => {
    const { p } = provider();
    expect(await p.getCheckout("sub_1")).toMatchObject({
      status: "complete",
      uid: "u1",
      planId: "pro",
      interval: "monthly",
      amountDueToday: 5900,
    });
  });
});

describe("StripeBillingProvider — subscriptions and plan changes", () => {
  it("maps plan from the price lookup key and periods from the subscription item", async () => {
    const { p } = provider();
    const s = await p.getSubscription("sub_1");
    expect(s).toMatchObject({
      id: "sub_1",
      uid: "u1",
      planId: "pro",
      interval: "monthly",
      amount: 5900,
      status: "active",
      cancelAtPeriodEnd: false,
    });
    expect(s?.currentPeriodEnd).toBe(
      new Date((T + 30 * 86400) * 1000).toISOString(),
    );
  });

  it("a scheduled downgrade shows as scheduledChange", async () => {
    const m = mockClient();
    const future = Math.floor(Date.now() / 1000) + 86400;
    m.raw.subscriptions.retrieve = jest.fn(() =>
      Promise.resolve(
        subObj({
          schedule: {
            id: "sub_sched_1",
            status: "active",
            phases: [
              { start_date: T, items: [{ price: "price_pro_monthly" }] },
              {
                start_date: future,
                items: [{ price: "price_starter_monthly" }],
              },
            ],
          },
        }),
      ),
    );
    const { p } = provider({}, m);
    expect((await p.getSubscription("sub_1"))?.scheduledChange).toEqual({
      planId: "starter",
      interval: "monthly",
      effectiveAt: new Date(future * 1000).toISOString(),
    });
  });

  it("downgrade: applied now with always_invoice proration (the negative total credits the balance); keeps any cancel date", async () => {
    const { p, m } = provider();
    await p.changePlan({
      subscriptionId: "sub_1",
      target: STARTER_M,
      kind: "downgrade",
      prorationDate: T * 1000,
      expectedAmountDue: null,
    });
    const [id, args] = m.calls["subscriptions.update"][0] as [string, Record<string, unknown>];
    expect(id).toBe("sub_1");
    expect(args).toMatchObject({ proration_behavior: "always_invoice", items: [{ price: "price_starter_monthly" }] });
    expect("cancel_at_period_end" in args).toBe(false);
    expect(m.calls["subscriptionSchedules.create"] ?? []).toEqual([]);
  });

  it("scheduled (annual → monthly): keeps the plan to period end, then the new price + metadata via a subscription schedule", async () => {
    const { p, m } = provider();
    const r = await p.changePlan({
      subscriptionId: "sub_1",
      target: STARTER_M,
      kind: "scheduled",
      prorationDate: Date.now(),
      expectedAmountDue: null,
    });
    expect(r).toEqual({
      status: "scheduled",
      effectiveAt: new Date((T + 30 * 86400) * 1000).toISOString(),
    });
    expect(m.calls["subscriptionSchedules.create"][0]).toEqual([
      { from_subscription: "sub_1" },
    ]);
    const [, upd] = m.calls["subscriptionSchedules.update"][0] as [
      string,
      { phases: Array<Record<string, unknown>> },
    ];
    expect(upd.phases[0]).toMatchObject({
      items: [{ price: "price_pro_monthly" }],
      end_date: T + 30 * 86400,
    });
    expect(upd.phases[1]).toMatchObject({
      items: [{ price: "price_starter_monthly" }],
      metadata: { planId: "starter", interval: "monthly" },
    });
  });

  // Stripe rejects anything but these with payment_behavior=pending_if_incomplete
  // (verified against Stripe test mode 2026-11-13: default_payment_method → 400).
  const PENDING_OK = new Set(["items", "proration_behavior", "proration_date", "billing_cycle_anchor", "payment_behavior", "expand", "trial_end"]);

  it("upgrade: prorated invoice charged now; the pending update carries only fields Stripe supports, metadata/resume only once applied", async () => {
    const { p, m } = provider();
    const r = await p.changePlan({
      subscriptionId: "sub_1",
      target: ELITE_M,
      kind: "upgrade",
      prorationDate: T * 1000,
      expectedAmountDue: null,
    });
    expect(r).toMatchObject({
      status: "applied",
      invoiceId: "in_1",
      amountCharged: 5900,
    });
    const [[, change], [, after]] = m.calls["subscriptions.update"] as Array<[string, Record<string, unknown>]>;
    expect(change).toMatchObject({
      items: [{ id: "si_1", price: "price_elite_monthly" }],
      proration_behavior: "always_invoice",
      proration_date: T,
      payment_behavior: "pending_if_incomplete",
    });
    expect(Object.keys(change).filter((k) => !PENDING_OK.has(k))).toEqual([]);
    expect(change.billing_cycle_anchor).toBeUndefined();
    expect(after).toEqual({ metadata: { uid: "u1", planId: "elite", interval: "monthly" }, cancel_at_period_end: false });
  });

  it("the card and billing address from the payment step become the subscription's (separate update), then the change is charged", async () => {
    const { p, m } = provider();
    await p.changePlan({
      subscriptionId: "sub_1",
      target: ELITE_M,
      kind: "upgrade",
      prorationDate: T * 1000,
      expectedAmountDue: null,
      paymentMethodId: "pm_new123",
      billing: { name: "Pat Doe", address: { line1: "1 Main St", line2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
    });
    expect(m.calls["customers.update"][0]).toEqual(["cus_1", expect.objectContaining({ name: "Pat Doe", address: expect.objectContaining({ line1: "1 Main St", postal_code: "78701", country: "US" }) })]);
    expect(m.calls["paymentMethods.attach"][0]).toEqual(["pm_new123", { customer: "cus_1" }]);
    const ups = m.calls["subscriptions.update"] as Array<[string, Record<string, unknown>]>;
    expect(ups[0]).toEqual(["sub_1", { default_payment_method: "pm_new123" }]);
    expect(ups[1][1]).toMatchObject({ payment_behavior: "pending_if_incomplete" });
    expect(Object.keys(ups[1][1]).filter((k) => !PENDING_OK.has(k))).toEqual([]);
  });

  it("free trial: monthly → annual keeps the trial (no billing_cycle_anchor — Stripe refuses one before the trial end)", async () => {
    const m = mockClient();
    m.raw.subscriptions.retrieve = jest.fn(() => Promise.resolve(subObj({ status: "trialing", trial_end: T + 7 * 86400 })));
    const { p } = provider({}, m);
    const target = { ...PRO_M, interval: "annual" as const, lookupKey: "pro_annual", amount: 56640 };
    await p.previewChange({ subscriptionId: "sub_1", target, kind: "upgrade" });
    const [prev] = m.calls["invoices.createPreview"].at(-1) as [{ subscription_details: Record<string, unknown> }];
    expect(prev.subscription_details.billing_cycle_anchor).toBeUndefined();
    await p.changePlan({ subscriptionId: "sub_1", target, kind: "upgrade", prorationDate: T * 1000, expectedAmountDue: null });
    const [, change] = m.calls["subscriptions.update"][0] as [string, Record<string, unknown>];
    expect(change.billing_cycle_anchor).toBeUndefined();
  });

  it("free trial: a scheduled change keeps the trial end on the current phase (without it Stripe ends the trial at once)", async () => {
    const m = mockClient();
    m.raw.subscriptions.retrieve = jest.fn(() => Promise.resolve(subObj({ status: "trialing", trial_end: T + 7 * 86400 })));
    const { p } = provider({}, m);
    await p.changePlan({ subscriptionId: "sub_1", target: STARTER_M, kind: "scheduled", prorationDate: Date.now(), expectedAmountDue: null, paymentMethodId: "pm_9" });
    const [, upd] = m.calls["subscriptionSchedules.update"][0] as [string, { phases: Array<Record<string, unknown>> }];
    expect(upd.phases[0]).toMatchObject({ trial_end: T + 7 * 86400 });
    // The card entered now is the one charged when the new plan starts.
    expect(m.calls["subscriptions.update"][0]).toEqual(["sub_1", { default_payment_method: "pm_9" }]);
  });

  it("'already paid' is what was paid this period for the current plan: its paid invoice lines, net of discounts, before tax", async () => {
    const m = mockClient();
    const end = T + 30 * 86400;
    (m.raw.invoices as Record<string, unknown>).list = jest.fn(() => Promise.resolve({ data: [
      { lines: { data: [
        { amount: 5900, period: { start: T, end }, pricing: { price_details: { price: "price_pro_monthly" } }, discount_amounts: [{ amount: 2950 }] },
      ] } },
      { lines: { data: [
        { amount: 5900, period: { start: T - 30 * 86400, end: T }, pricing: { price_details: { price: "price_pro_monthly" } } },
      ] } },
    ] }));
    m.raw.invoices.createPreview = jest.fn(() => Promise.resolve({
      currency: "usd", subtotal: 0, total: 9000, amount_due: 9000, total_taxes: [], total_discount_amounts: [],
      lines: { data: [
        { amount: -2655, description: "Unused time on Pro", period: { start: T + 3 * 86400, end }, proration: true },
        { amount: 11655, description: "Remaining time on Elite", period: { start: T + 3 * 86400, end }, proration: true },
      ] },
    }));
    const { p } = provider({}, m);
    const prev = await p.previewChange({ subscriptionId: "sub_1", target: ELITE_M, kind: "upgrade" });
    expect(prev.alreadyPaid).toBe(2950);
    expect(prev.unusedCredit).toBe(2655);
    expect(prev.newPlanCharge).toBe(11655);
  });

  it("upgrade needing 3-D Secure returns the client secret; monthly→annual restarts the period", async () => {
    const m = mockClient();
    m.raw.subscriptions.update = jest.fn(() =>
      Promise.resolve(
        subObj({
          pending_update: { expires_at: T },
          latest_invoice: {
            id: "in_2",
            amount_due: 1000,
            status: "open",
            confirmation_secret: { client_secret: "pi_secret_2" },
          },
        }),
      ),
    );
    const { p } = provider({}, m);
    const r = await p.changePlan({
      subscriptionId: "sub_1",
      target: {
        ...PRO_M,
        interval: "annual",
        lookupKey: "pro_annual",
        amount: 56640,
      },
      kind: "upgrade",
      prorationDate: T * 1000,
      expectedAmountDue: null,
    });
    expect(r).toEqual({
      status: "requires_action",
      actionId: "in_2",
      clientSecret: "pi_secret_2",
      amountDue: 1000,
    });
    expect(
      (m.raw.subscriptions.update as jest.Mock).mock.calls[0][1],
    ).toMatchObject({ billing_cycle_anchor: "now" });
  });

  it("3-D Secure upgrade: tags the invoice, then finishes the change (plan + resume) once it is paid", async () => {
    const m = mockClient();
    m.raw.subscriptions.update = jest.fn(() =>
      Promise.resolve(subObj({ pending_update: { expires_at: T }, latest_invoice: { id: "in_2", amount_due: 1000, status: "open", confirmation_secret: { client_secret: "pi_secret_2" } } })),
    );
    const { p } = provider({}, m);
    await p.changePlan({ subscriptionId: "sub_1", target: ELITE_M, kind: "upgrade", prorationDate: T * 1000, expectedAmountDue: null });
    const tag = m.calls["invoices.update"]?.[0] as [string, { metadata: Record<string, string> }];
    expect(tag[0]).toBe("in_2");
    expect(tag[1].metadata).toMatchObject({ mc_change: "upgrade", mc_plan: ELITE_M.planId, mc_interval: ELITE_M.interval });

    // Paid: Stripe has applied the pending update; the subscription was set to cancel.
    m.raw.invoices.retrieve = jest.fn(() => Promise.resolve({ id: "in_2", status: "paid", metadata: tag[1].metadata, parent: { subscription_details: { subscription: "sub_1" } } }));
    m.raw.subscriptions.retrieve = jest.fn(() => Promise.resolve(subObj({ cancel_at_period_end: true, metadata: { uid: "u1", planId: "pro", interval: "monthly" } })));
    const upd = jest.fn(() => Promise.resolve(subObj()));
    m.raw.subscriptions.update = upd;
    expect(await p.completePendingChange("in_2")).toBe(true);
    expect(upd).toHaveBeenCalledWith("sub_1", { metadata: { uid: "u1", planId: ELITE_M.planId, interval: ELITE_M.interval }, cancel_at_period_end: false });

    // Still waiting on the bank, or an unrelated invoice: nothing happens.
    upd.mockClear();
    m.raw.subscriptions.retrieve = jest.fn(() => Promise.resolve(subObj({ pending_update: { expires_at: T } })));
    expect(await p.completePendingChange("in_2")).toBe(false);
    m.raw.invoices.retrieve = jest.fn(() => Promise.resolve({ id: "in_9", status: "paid", metadata: {}, parent: { subscription_details: { subscription: "sub_1" } } }));
    expect(await p.completePendingChange("in_9")).toBe(false);
    expect(upd).not.toHaveBeenCalled();
  });

  it("a scheduled change keeps the customer's discount (retention/promo) on both schedule phases", async () => {
    const m = mockClient();
    m.raw.subscriptions.retrieve = jest.fn(() => Promise.resolve(subObj({ discounts: [{ id: "di_ret", coupon: { id: "mc_retention_x", percent_off: 50, duration: "repeating" } }] })));
    const { p } = provider({}, m);
    await p.changePlan({ subscriptionId: "sub_1", target: STARTER_M, kind: "scheduled", prorationDate: Date.now(), expectedAmountDue: null });
    const [, upd] = m.calls["subscriptionSchedules.update"][0] as [string, { phases: Array<Record<string, unknown>> }];
    expect(upd.phases[0].discounts).toEqual([{ discount: "di_ret" }]);
    expect(upd.phases[1].discounts).toEqual([{ discount: "di_ret" }]);
  });

  it("retention on a subscription with a pending scheduled change also rewrites the schedule's phases with the discount", async () => {
    const m = mockClient();
    const end = T + 30 * 86400;
    m.raw.subscriptions.retrieve = jest.fn(() => Promise.resolve(subObj({ schedule: "sub_sched_1", discounts: [{ id: "di_ret", coupon: { id: "mc_retention_x" } }] })));
    m.raw.subscriptionSchedules.retrieve = jest.fn(() => Promise.resolve({ id: "sub_sched_1", status: "active", phases: [
      { items: [{ price: "price_pro_monthly" }], start_date: T, end_date: end, metadata: { planId: "pro" } },
      { items: [{ price: { id: "price_starter_monthly" } }], start_date: end, end_date: end + 30 * 86400, metadata: { planId: "starter" }, proration_behavior: "none" },
    ] }));
    const { p } = provider({}, m);
    await p.applyRetentionDiscount({ subscriptionId: "sub_1", customerId: "cus_1", mode: "percent_next_invoices", percentOff: 50, invoices: 2 });
    const [id, upd] = m.calls["subscriptionSchedules.update"].at(-1) as [string, { phases: Array<Record<string, unknown>> }];
    expect(id).toBe("sub_sched_1");
    expect(upd.phases.map((ph) => ph.discounts)).toEqual([[{ discount: "di_ret" }], [{ discount: "di_ret" }]]);
    expect(upd.phases[1]).toMatchObject({ items: [{ price: "price_starter_monthly" }], proration_behavior: "none" });
  });

  it("a stale preview is refused", async () => {
    const { p } = provider();
    await expect(
      p.changePlan({
        subscriptionId: "sub_1",
        target: ELITE_M,
        kind: "upgrade",
        prorationDate: T * 1000,
        expectedAmountDue: 1,
      }),
    ).rejects.toBeInstanceOf(PreviewStaleError);
  });

  it("retention: generated coupon on the subscription, or a balance credit", async () => {
    const { p, m } = provider();
    await p.applyRetentionDiscount({
      subscriptionId: "sub_1",
      customerId: "cus_1",
      mode: "percent_next_invoices",
      percentOff: 50,
      invoices: 2,
    });
    expect(m.calls["coupons.create"][0][0]).toMatchObject({
      percent_off: 50,
      duration: "repeating",
      duration_in_months: 2,
    });
    await p.applyRetentionDiscount({
      subscriptionId: "sub_1",
      customerId: "cus_1",
      mode: "balance_credit",
      amount: 14925,
      currency: "USD",
    });
    expect(m.calls["customers.createBalanceTransaction"][0]).toEqual([
      "cus_1",
      {
        amount: -14925,
        currency: "usd",
        description: "Retention offer credit",
      },
    ]);
  });

  it("the reconcile list skips ended subscriptions", async () => {
    const { p } = provider();
    expect((await p.listSubscriptions()).map((s) => s.id)).toEqual(["sub_1"]);
  });
});

describe("StripeBillingProvider — portal, contact", () => {
  it("portal uses the configured portal; no phone goes to the customer", async () => {
    const { p, m } = provider({ STRIPE_PORTAL_CONFIGURATION: "bpc_123" });
    expect(
      await p.createPortalSession({
        customerId: "cus_1",
        returnUrl: "https://app.example.com/manage-plan",
      }),
    ).toEqual({ url: "https://billing.stripe.example/session" });
    expect(m.calls["portal.create"][0][0]).toEqual({
      customer: "cus_1",
      return_url: "https://app.example.com/manage-plan",
      configuration: "bpc_123",
    });
    // No phone is ever sent to Stripe.
    expect(JSON.stringify(m.calls["customers.update"] ?? [])).not.toMatch(/phone/);
  });
});

describe("StripeBillingProvider — webhooks", () => {
  const ev = (type: string, object: object) => ({
    id: `evt_${type}`,
    object: "event",
    type,
    created: T,
    livemode: false,
    data: { object },
  });

  it("rejects a bad or missing signature", async () => {
    const { p } = provider();
    const { payload } = signed(ev("customer.subscription.updated", subObj()));
    await expect(p.parseEvent(payload, "t=1,v1=bad")).rejects.toBeInstanceOf(
      InvalidEventSignatureError,
    );
    await expect(p.parseEvent(payload, undefined)).rejects.toBeInstanceOf(
      InvalidEventSignatureError,
    );
  });

  it("subscription events carry uid and subscription id", async () => {
    const { p } = provider();
    const { payload, header } = signed(
      ev("customer.subscription.updated", subObj()),
    );
    expect(await p.parseEvent(payload, header)).toEqual({
      id: "evt_customer.subscription.updated",
      type: "subscription.updated",
      created: T * 1000,
      provider: "stripe",
      data: { uid: "u1", customerId: "cus_1", subscriptionId: "sub_1" },
    });
  });

  it("the first paid invoice is checkout.completed (session id = subscription id); first-payment failures are left to the checkout page", async () => {
    const { p } = provider();
    const inv = (reason: string) => ({
      id: "in_1",
      object: "invoice",
      customer: "cus_1",
      billing_reason: reason,
      amount_paid: 6387,
      amount_due: 6387,
      parent: {
        subscription_details: {
          subscription: "sub_1",
          metadata: { uid: "u1" },
        },
      },
    });
    const first = signed(ev("invoice.paid", inv("subscription_create")));
    expect(await p.parseEvent(first.payload, first.header)).toMatchObject({
      type: "checkout.completed",
      data: {
        checkoutSessionId: "sub_1",
        subscriptionId: "sub_1",
        invoiceId: "in_1",
        uid: "u1",
        amount: 6387,
      },
    });
    const failed = signed(
      ev("invoice.payment_failed", inv("subscription_create")),
    );
    expect(await p.parseEvent(failed.payload, failed.header)).toBeNull();
    const renewal = signed(ev("invoice.paid", inv("subscription_cycle")));
    expect(await p.parseEvent(renewal.payload, renewal.header)).toMatchObject({
      type: "invoice.paid",
      data: { invoiceId: "in_1", checkoutSessionId: null },
    });
  });

  it("charge.refunded is tied back to its invoice through the payment intent", async () => {
    const { p } = provider();
    const { payload, header } = signed(
      ev("charge.refunded", {
        id: "ch_1",
        object: "charge",
        customer: "cus_1",
        payment_intent: "pi_1",
        amount_refunded: 5900,
      }),
    );
    expect(await p.parseEvent(payload, header)).toMatchObject({
      type: "charge.refunded",
      data: { invoiceId: "in_1", amount: 5900 },
    });
  });

  it("ignores events from the other mode (live event on a test key, test event on a live key)", async () => {
    const sub = () => ev("customer.subscription.updated", subObj());
    const test = provider();
    const liveEv = signed({ ...sub(), livemode: true });
    expect(await test.p.parseEvent(liveEv.payload, liveEv.header)).toBeNull();
    const testEv = signed(sub());
    expect(
      await test.p.parseEvent(testEv.payload, testEv.header),
    ).not.toBeNull();
    const live = provider({ STRIPE_SECRET_KEY: "sk_live_x" });
    expect(live.p.livemode).toBe(true);
    expect(await live.p.parseEvent(testEv.payload, testEv.header)).toBeNull();
    expect(
      await live.p.parseEvent(liveEv.payload, liveEv.header),
    ).not.toBeNull();
  });

  it("events we don't use are ignored; the endpoint subscribes to exactly the mapped list", async () => {
    const { p } = provider();
    const { payload, header } = signed(
      ev("customer.updated", { id: "cus_1", object: "customer" }),
    );
    expect(await p.parseEvent(payload, header)).toBeNull();
    expect(STRIPE_WEBHOOK_EVENTS).toEqual(
      expect.arrayContaining([
        "customer.subscription.updated",
        "invoice.paid",
        "invoice.payment_failed",
        "charge.refunded",
      ]),
    );
  });
});
