import { ConfigService } from "@nestjs/config";
import { FakeFirestore } from "../../../../test/support/fake-firestore";
import { AppClock } from "../../../common/app-clock";
import { FirebaseAdminService } from "../../../common/firebase-admin.provider";
import {
  catalogPrice,
  type BillingInterval,
} from "../../../plans/plans.registry";
import {
  InvalidEventSignatureError,
  PreviewStaleError,
} from "../billing-provider";
import { configuredProvider, createBillingProvider } from "../provider.factory";
import { StripeBillingProvider } from "../stripe/stripe-billing.provider";
import type { PriceRef, ProviderEvent } from "../types";
import { addInterval, FakeBillingProvider } from "./fake-billing.provider";

const T0 = Date.parse("2026-11-10T12:00:00Z");
const DAY = 86_400_000;

function price(planId: string, interval: BillingInterval): PriceRef {
  const p = catalogPrice(planId, interval);
  return {
    planId,
    interval,
    amount: p.amount,
    currency: "USD",
    lookupKey: p.lookupKey,
  };
}

function setup() {
  const fs = new FakeFirestore();
  const clock = new AppClock();
  const provider = new FakeBillingProvider(
    { firestore: fs } as unknown as FirebaseAdminService,
    clock,
    { appUrl: "http://app.test" },
  );
  clock.freeze(T0);
  const events: ProviderEvent[] = [];
  provider.setEventSink(async (raw, sig) => {
    events.push(provider.parseEvent(raw, sig));
  });
  return {
    fs,
    clock,
    provider,
    events,
    types: () => events.map((e) => e.type),
  };
}

async function subscribe(
  t: ReturnType<typeof setup>,
  planId = "pro",
  interval: BillingInterval = "monthly",
  card: Parameters<FakeBillingProvider["completeCheckout"]>[1] = "success",
  discount = null,
) {
  const { customerId } = await t.provider.createCustomer({
    uid: "u1",
    email: "u1@example.com",
  });
  const session = await t.provider.createCheckout({
    uid: "u1",
    customerId,
    price: price(planId, interval),
    discount,
    successUrl: "http://app.test/billing/success?session={CHECKOUT_SESSION_ID}",
    cancelUrl: "http://app.test/manage-plan",
    idempotencyKey: `k-${planId}-${interval}`,
  });
  const done = await t.provider.completeCheckout(session.id, card);
  return { customerId, session, done };
}

describe("FakeBillingProvider: checkout", () => {
  it("4242 succeeds: active subscription, paid invoice, events in Stripe's order", async () => {
    const t = setup();
    const { done, session } = await subscribe(t);
    expect(done.status).toBe("complete");
    expect(done.redirectUrl).toBe(
      `http://app.test/billing/success?session=${session.id}`,
    );
    const sub = await t.provider.getSubscription(done.subscriptionId);
    expect(sub).toMatchObject({
      status: "active",
      planId: "pro",
      interval: "monthly",
      amount: 5900,
    });
    expect(sub.currentPeriodEnd).toBe(
      new Date(addInterval(T0, "monthly")).toISOString(),
    );
    const inv = await t.provider.getInvoice(sub.latestInvoiceId);
    expect(inv).toMatchObject({
      status: "paid",
      total: 5900,
      amountPaid: 5900,
      billingReason: "subscription_create",
    });
    expect(t.types()).toEqual([
      "checkout.completed",
      "subscription.created",
      "invoice.paid",
    ]);
  });

  it.each([
    ["decline", "card_declined"],
    ["insufficient_funds", "insufficient_funds"],
  ] as const)(
    "%s fails with %s and creates no subscription",
    async (card, code) => {
      const t = setup();
      const { done } = await subscribe(t, "pro", "monthly", card);
      expect(done).toEqual({ status: "failed", code });
      expect(await t.provider.listSubscriptions()).toEqual([]);
      expect(t.events).toEqual([]);
    },
  );

  it("3-D Secure requires an action; approving completes it, rejecting fails it", async () => {
    const t = setup();
    const { done } = await subscribe(t, "pro", "monthly", "requires_3ds");
    expect(done.status).toBe("requires_action");
    expect(await t.provider.confirmAction(done.actionId, true)).toMatchObject({
      status: "complete",
    });
    expect((await t.provider.listSubscriptions()).length).toBe(1);

    const t2 = setup();
    const r2 = await subscribe(t2, "pro", "monthly", "requires_3ds");
    expect(await t2.provider.confirmAction(r2.done.actionId, false)).toEqual({
      status: "failed",
      code: "authentication_failed",
    });
    expect(await t2.provider.listSubscriptions()).toEqual([]);
  });

  it("the same idempotency key returns the same open session", async () => {
    const t = setup();
    const { customerId } = await t.provider.createCustomer({
      uid: "u1",
      email: null,
    });
    const args = {
      uid: "u1",
      customerId,
      price: price("starter", "annual"),
      discount: null,
      successUrl: "s",
      cancelUrl: "c",
      idempotencyKey: "same",
    };
    const a = await t.provider.createCheckout(args);
    const b = await t.provider.createCheckout(args);
    expect(b.id).toBe(a.id);
  });

  it("an abandoned checkout expires after 24 hours", async () => {
    const t = setup();
    const { customerId } = await t.provider.createCustomer({
      uid: "u1",
      email: null,
    });
    await t.provider.createCheckout({
      uid: "u1",
      customerId,
      price: price("pro", "monthly"),
      discount: null,
      successUrl: "s",
      cancelUrl: "c",
      idempotencyKey: "x",
    });
    await t.provider.advanceDays(1.01);
    expect(t.types()).toEqual(["checkout.expired"]);
    expect(await t.provider.listSubscriptions()).toEqual([]);
  });

  it("a 20%-once promo discounts only the first annual invoice", async () => {
    const t = setup();
    const { done, session } = await subscribe(
      t,
      "starter",
      "annual",
      "success",
      {
        source: "promo",
        code: "SAVE20",
        percentOff: 20,
        duration: "once",
      },
    );
    expect(session.amountDueToday).toBe(37440 - 7488);
    const sub = await t.provider.getSubscription(done.subscriptionId);
    expect((await t.provider.getInvoice(sub.latestInvoiceId)).total).toBe(
      29952,
    );
    await t.provider.advanceDays(366);
    const renewal = await t.provider.getInvoice(
      (await t.provider.getSubscription(sub.id)).latestInvoiceId,
    );
    expect(renewal.total).toBe(37440);
  });
});

describe("FakeBillingProvider: renewals, cancel, downgrade", () => {
  it("renews monthly with a reminder 7 days before", async () => {
    const t = setup();
    const { done } = await subscribe(t);
    t.events.length = 0;
    const r = await t.provider.advanceDays(31);
    expect(r.processed[0]).toMatch(/^upcoming/);
    expect(t.types()).toEqual([
      "invoice.upcoming",
      "invoice.paid",
      "subscription.updated",
    ]);
    const sub = await t.provider.getSubscription(done.subscriptionId);
    expect(sub.currentPeriodStart).toBe(
      new Date(addInterval(T0, "monthly")).toISOString(),
    );
  });

  it("cancel at period end: access to the exact end date, then deleted", async () => {
    const t = setup();
    const { done } = await subscribe(t, "pro", "annual");
    await t.provider.cancelAtPeriodEnd(done.subscriptionId);
    const end = Date.parse(
      (await t.provider.getSubscription(done.subscriptionId)).currentPeriodEnd,
    );
    await t.provider.advanceTo(end - 1);
    expect((await t.provider.getSubscription(done.subscriptionId)).status).toBe(
      "active",
    );
    t.events.length = 0;
    await t.provider.advanceTo(end);
    const sub = await t.provider.getSubscription(done.subscriptionId);
    expect(sub).toMatchObject({
      status: "canceled",
      endedAt: new Date(end).toISOString(),
    });
    expect(t.types()).toEqual(["subscription.deleted"]);
  });

  it("resume before the end keeps it renewing", async () => {
    const t = setup();
    const { done } = await subscribe(t);
    await t.provider.cancelAtPeriodEnd(done.subscriptionId);
    await t.provider.resume(done.subscriptionId);
    await t.provider.advanceDays(32);
    expect((await t.provider.getSubscription(done.subscriptionId)).status).toBe(
      "active",
    );
  });

  it("a downgrade takes effect at period end and bills the new price", async () => {
    const t = setup();
    const { done } = await subscribe(t, "elite", "monthly");
    const r = await t.provider.changePlan({
      subscriptionId: done.subscriptionId,
      target: price("starter", "monthly"),
      kind: "downgrade",
      prorationDate: T0,
      expectedAmountDue: null,
    });
    expect(r.status).toBe("scheduled");
    expect((await t.provider.getSubscription(done.subscriptionId)).planId).toBe(
      "elite",
    );
    await t.provider.advanceDays(31);
    const sub = await t.provider.getSubscription(done.subscriptionId);
    expect(sub).toMatchObject({
      planId: "starter",
      amount: 3900,
      scheduledChange: null,
    });
    expect((await t.provider.getInvoice(sub.latestInvoiceId)).total).toBe(3900);
  });

  it("failed renewals retry on days 1, 3, 5 and 7, then the subscription ends", async () => {
    const t = setup();
    const { done } = await subscribe(t, "pro", "monthly", "renewal_failure");
    const end = Date.parse(
      (await t.provider.getSubscription(done.subscriptionId)).currentPeriodEnd,
    );
    await t.provider.advanceTo(end);
    expect((await t.provider.getSubscription(done.subscriptionId)).status).toBe(
      "past_due",
    );
    await t.provider.advanceTo(end + 6 * DAY);
    expect((await t.provider.getSubscription(done.subscriptionId)).status).toBe(
      "past_due",
    );
    await t.provider.advanceTo(end + 7 * DAY);
    const sub = await t.provider.getSubscription(done.subscriptionId);
    expect(sub.status).toBe("canceled");
    expect(t.types().filter((x) => x === "invoice.payment_failed").length).toBe(
      5,
    );
    expect(t.types().at(-1)).toBe("subscription.deleted");
  });

  it("updating the card in the portal pays the open invoice", async () => {
    const t = setup();
    const { done, customerId } = await subscribe(
      t,
      "pro",
      "monthly",
      "renewal_failure",
    );
    await t.provider.advanceDays(31);
    expect(await t.provider.updateCard(customerId, "success")).toEqual({
      retried: 1,
      paid: 1,
    });
    expect(await t.provider.getSubscription(done.subscriptionId)).toMatchObject(
      { status: "active", pastDueSince: null },
    );
  });
});

describe("FakeBillingProvider: upgrades and retention", () => {
  it("the upgrade preview equals the amount charged (same interval, prorated)", async () => {
    const t = setup();
    const { done } = await subscribe(t, "starter", "monthly");
    t.clock.freeze(T0 + 10 * DAY);
    const preview = await t.provider.previewChange({
      subscriptionId: done.subscriptionId,
      target: price("pro", "monthly"),
      kind: "upgrade",
    });
    expect(preview.amountDueNow).toBeGreaterThan(0);
    expect(preview.amountDueNow).toBeLessThan(5900 - 3900);
    const r = await t.provider.changePlan({
      subscriptionId: done.subscriptionId,
      target: price("pro", "monthly"),
      kind: "upgrade",
      prorationDate: preview.prorationDate,
      expectedAmountDue: preview.amountDueNow,
    });
    expect(r).toMatchObject({
      status: "applied",
      amountCharged: preview.amountDueNow,
    });
    const sub = await t.provider.getSubscription(done.subscriptionId);
    expect((await t.provider.getInvoice(sub.latestInvoiceId)).total).toBe(
      preview.amountDueNow,
    );
    expect(sub.planId).toBe("pro");
  });

  it("monthly → annual charges the annual price minus unused time and restarts the period", async () => {
    const t = setup();
    const { done } = await subscribe(t, "pro", "monthly");
    const preview = await t.provider.previewChange({
      subscriptionId: done.subscriptionId,
      target: price("pro", "annual"),
      kind: "upgrade",
    });
    expect(preview.amountDueNow).toBe(56640 - 5900);
    await t.provider.changePlan({
      subscriptionId: done.subscriptionId,
      target: price("pro", "annual"),
      kind: "upgrade",
      prorationDate: preview.prorationDate,
      expectedAmountDue: preview.amountDueNow,
    });
    const sub = await t.provider.getSubscription(done.subscriptionId);
    expect(sub.currentPeriodEnd).toBe(
      new Date(addInterval(T0, "annual")).toISOString(),
    );
  });

  it("a stale preview is refused", async () => {
    const t = setup();
    const { done } = await subscribe(t, "starter", "monthly");
    await expect(
      t.provider.changePlan({
        subscriptionId: done.subscriptionId,
        target: price("pro", "monthly"),
        kind: "upgrade",
        prorationDate: T0,
        expectedAmountDue: 1,
      }),
    ).rejects.toBeInstanceOf(PreviewStaleError);
  });

  it("retention (monthly): next 2 invoices at 50%, the third at full price", async () => {
    const t = setup();
    const { done, customerId } = await subscribe(t, "pro", "monthly");
    await t.provider.applyRetentionDiscount({
      subscriptionId: done.subscriptionId,
      customerId,
      mode: "percent_next_invoices",
      percentOff: 50,
      invoices: 2,
    });
    const totals: number[] = [];
    for (let i = 0; i < 3; i++) {
      await t.provider.advanceDays(31);
      const sub = await t.provider.getSubscription(done.subscriptionId);
      totals.push((await t.provider.getInvoice(sub.latestInvoiceId)).total);
    }
    expect(totals).toEqual([2950, 2950, 5900]);
  });

  it("retention (annual): a balance credit comes off the next invoice", async () => {
    const t = setup();
    const { done, customerId } = await subscribe(t, "pro", "annual");
    await t.provider.applyRetentionDiscount({
      subscriptionId: done.subscriptionId,
      customerId,
      mode: "balance_credit",
      amount: 4720,
      currency: "USD",
    });
    expect(
      (await t.provider.getUpcomingInvoice(done.subscriptionId)).total,
    ).toBe(56640 - 4720);
    await t.provider.advanceDays(366);
    const sub = await t.provider.getSubscription(done.subscriptionId);
    expect(await t.provider.getInvoice(sub.latestInvoiceId)).toMatchObject({
      total: 51920,
      creditApplied: 4720,
    });
  });
});

describe("FakeBillingProvider: events", () => {
  it("rejects unsigned and tampered events", async () => {
    const t = setup();
    const raw = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
    expect(() => t.provider.parseEvent(raw, undefined)).toThrow(
      InvalidEventSignatureError,
    );
    expect(() =>
      t.provider.parseEvent(
        raw.replace("paid", "payment_failed"),
        t.provider.sign(raw),
      ),
    ).toThrow(InvalidEventSignatureError);
    expect(t.provider.parseEvent(raw, t.provider.sign(raw)).id).toBe("evt_1");
  });
});

describe("provider factory safety", () => {
  const cfg = (env: Record<string, string>) =>
    ({
      get: (k: string, d?: unknown) => env[k] ?? d,
    }) as unknown as ConfigService;
  const fb = {
    firestore: new FakeFirestore(),
  } as unknown as FirebaseAdminService;

  it("refuses the fake provider in the production project", () => {
    expect(() =>
      createBillingProvider(
        cfg({
          BILLING_PROVIDER: "fake",
          FIREBASE_PROJECT_ID: "market-catalyst-502415",
        }),
        fb,
        new AppClock(),
      ),
    ).toThrow(/not allowed in the production project/);
  });
  it("allows it in staging and local", () => {
    expect(
      createBillingProvider(
        cfg({
          BILLING_PROVIDER: "fake",
          FIREBASE_PROJECT_ID: "market-catalyst-stage",
        }),
        fb,
        new AppClock(),
      ),
    ).toBeInstanceOf(FakeBillingProvider);
  });
  it("selects Stripe by config only, and nothing when unset", () => {
    expect(
      createBillingProvider(
        cfg({ BILLING_PROVIDER: "stripe" }),
        fb,
        new AppClock(),
      ),
    ).toBeInstanceOf(StripeBillingProvider);
    expect(createBillingProvider(cfg({}), fb, new AppClock())).toBeNull();
    expect(configuredProvider(cfg({ BILLING_PROVIDER: "paypal" }))).toBe(
      "none",
    );
  });
});
