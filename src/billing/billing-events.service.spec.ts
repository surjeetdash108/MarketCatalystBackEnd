import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { billingHarness, DAY, T0 } from "../../test/support/billing-harness";
import { AppClock } from "../common/app-clock";
import { BillingEventsService } from "./billing-events.service";

describe("billing event handler: the only writer of billing state", () => {
  it("checkout.completed that carries the first invoice (Stripe) also records that payment", async () => {
    const h = billingHarness();
    const { subscriptionId, session } = await h.buy("u2", "pro", "monthly");
    const invoiceId = h.fs
      .ids("payments")
      .find((id) => h.fs.read("payments", id)?.userId === "u2")!;
    await h.fs.collection("payments").doc(invoiceId).delete();
    expect(h.fs.read("payments", invoiceId)).toBeUndefined();
    const r = await h.events.handle({
      id: "evt_stripe_first_invoice",
      type: "checkout.completed",
      created: h.clock.now(),
      provider: "fake",
      data: {
        uid: "u2",
        subscriptionId,
        checkoutSessionId: session.id,
        invoiceId,
      },
    });
    expect(r).toBe("processed");
    expect(h.fs.read("payments", invoiceId)).toMatchObject({
      userId: "u2",
      paymentStatus: "SUCCESS",
      amount: 5900,
    });
  });

  it("a completed checkout writes mirror, projection, customer, payment, claim, history and emails", async () => {
    const h = billingHarness();
    const { subscriptionId, customerId } = await h.buy("u1", "pro", "monthly");
    expect(h.fs.read("subscriptions", "u1")).toMatchObject({
      planId: "pro",
      interval: "monthly",
      status: "ACTIVE",
      subscriptionId,
      customerId,
      source: "provider",
    });
    expect(h.fs.read("users", "u1")).toMatchObject({
      currentPlan: "pro",
      subscriptionStatus: "ACTIVE",
      subscriptionInterval: "monthly",
    });
    expect(h.fs.read("customers", "u1")).toMatchObject({
      customerId,
      email: "u1@example.com",
    });
    const payments = h.fs
      .ids("payments")
      .map((id) => h.fs.read("payments", id));
    expect(payments).toEqual([
      expect.objectContaining({
        userId: "u1",
        planId: "pro",
        amount: 5900,
        paymentStatus: "SUCCESS",
        billingCycle: "monthly",
      }),
    ]);
    expect(h.auth.claim("u1")).toBe("pro");
    expect(
      h.fs
        .ids("subscription_events")
        .map((id) => h.fs.read("subscription_events", id).type),
    ).toEqual(["subscribed"]);
    expect(h.tags()).toEqual(expect.arrayContaining(["welcome", "receipt"]));
    expect((await h.subscriptions.forUser("u1")).entitlements.moneyFlow).toBe(
      true,
    );
  });

  it("rejects an unsigned or tampered event with 400 and writes nothing", async () => {
    const h = billingHarness();
    const raw = JSON.stringify({
      id: "evt_forged",
      type: "subscription.created",
      created: T0,
      provider: "fake",
      data: { subscriptionId: "sub_x" },
    });
    await expect(h.events.receive(raw, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      h.events.receive(raw, "t=1,v1=deadbeef"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.fs.ids("stripe_events")).toEqual([]);
    expect(h.fs.ids("subscriptions")).toEqual([]);
  });

  it("is idempotent: the same event delivered twice changes state once", async () => {
    const h = billingHarness();
    await h.buy("u1", "pro", "monthly");
    const before = {
      payments: h.fs.ids("payments").length,
      history: h.fs.ids("subscription_events").length,
      emails: h.sender.outbox.length,
    };
    for (const e of await h.provider.listEvents()) {
      await h.provider.redeliver(e.id);
      expect(await h.events.handle(e)).toBe("duplicate");
    }
    expect({
      payments: h.fs.ids("payments").length,
      history: h.fs.ids("subscription_events").length,
      emails: h.sender.outbox.length,
    }).toEqual(before);
  });

  it("is ordering-safe: an older event processed late re-reads current state instead of reverting it", async () => {
    const h = billingHarness();
    const { subscriptionId } = await h.buy("u1", "starter", "monthly");
    const created = (await h.provider.listEvents()).find(
      (e) => e.type === "subscription.created",
    );
    await h.provider.cancelAtPeriodEnd(subscriptionId);
    // Replay the original "created" event under a fresh id, as if delayed:
    const late = await h.events.handle({ ...created, id: "evt_late_copy" });
    expect(late).toBe("processed");
    expect(h.fs.read("subscriptions", "u1")).toMatchObject({
      cancelAtPeriodEnd: true,
    });
  });

  it("a late deletion of an OLD subscription cannot overwrite a newer live one", async () => {
    const h = billingHarness();
    const first = await h.buy("u1", "starter", "monthly");
    await h.provider.cancelAtPeriodEnd(first.subscriptionId);
    await h.provider.advanceDays(31); // first ends → CANCELLED
    const second = await h.buy("u1", "pro", "monthly");
    expect(h.fs.read("subscriptions", "u1")).toMatchObject({
      subscriptionId: second.subscriptionId,
      status: "ACTIVE",
    });
    const oldDeleted = (await h.provider.listEvents()).find(
      (e) => e.type === "subscription.deleted",
    );
    expect(
      await h.events.handle({ ...oldDeleted, id: "evt_late_deleted" }),
    ).toBe("processed");
    expect(h.fs.read("subscriptions", "u1")).toMatchObject({
      subscriptionId: second.subscriptionId,
      status: "ACTIVE",
      planId: "pro",
    });
  });

  it("cancel at period end: paid access to the exact end, then Free with claim and email", async () => {
    const h = billingHarness();
    const { subscriptionId } = await h.buy("u1", "pro", "monthly");
    await h.provider.cancelAtPeriodEnd(subscriptionId);
    expect(h.tags()).toContain("cancellation");
    const end = Date.parse(
      h.fs.read("subscriptions", "u1").currentPeriodEnd as string,
    );
    await h.provider.advanceTo(end - 1);
    expect((await h.subscriptions.forUser("u1")).planId).toBe("pro");
    await h.provider.advanceTo(end);
    expect(h.fs.read("subscriptions", "u1")).toMatchObject({
      status: "CANCELLED",
    });
    expect((await h.subscriptions.forUser("u1")).planId).toBe("free");
    expect(h.auth.claim("u1")).toBe("free");
    expect(h.tags()).toContain("plan_ended");
  });

  it("past due: 7-day grace with access and a payment-failed email, then Free", async () => {
    const h = billingHarness();
    await h.buy("u1", "pro", "monthly", "renewal_failure");
    const end = Date.parse(
      h.fs.read("subscriptions", "u1").currentPeriodEnd as string,
    );
    await h.provider.advanceTo(end + 1);
    const during = await h.subscriptions.forUser("u1");
    expect(during).toMatchObject({
      status: "PAST_DUE",
      inGrace: true,
      planId: "pro",
    });
    expect(during.graceEndsAt).toBe(new Date(end + 7 * DAY).toISOString());
    expect(h.tags()).toContain("payment_failed");
    const failed = h.fs
      .ids("payments")
      .map((id) => h.fs.read("payments", id))
      .filter((p) => p.paymentStatus === "FAILED");
    expect(failed.length).toBe(1);
    await h.provider.advanceTo(end + 7 * DAY);
    expect((await h.subscriptions.forUser("u1")).planId).toBe("free");
    expect(h.auth.claim("u1")).toBe("free");
  });

  it("past due without a provider deletion still drops to Free after the grace period", async () => {
    const h = billingHarness();
    h.fs.seed("subscriptions", "u9", {
      uid: "u9",
      planId: "elite",
      status: "PAST_DUE",
      pastDueSince: new Date(T0 - 8 * DAY).toISOString(),
      currentPeriodEnd: new Date(T0 + 20 * DAY).toISOString(),
    });
    expect(await h.subscriptions.forUser("u9")).toMatchObject({
      planId: "free",
      status: "EXPIRED",
      inGrace: false,
    });
  });

  it("refunds and disputes update the payment row", async () => {
    const h = billingHarness();
    const { subscriptionId } = await h.buy("u1", "pro", "monthly");
    const invoiceId = (await h.provider.getSubscription(subscriptionId))
      .latestInvoiceId;
    await h.provider.refundInvoice(invoiceId);
    expect(h.fs.read("payments", invoiceId)).toMatchObject({
      paymentStatus: "REFUNDED",
      amountRefunded: 5900,
    });
    await h.provider.disputeInvoice(invoiceId);
    expect(h.fs.read("payments", invoiceId)).toMatchObject({ disputed: true });
  });

  it("renewal reminder email 7 days before renewal", async () => {
    const h = billingHarness();
    await h.buy("u1", "starter", "annual");
    await h.provider.advanceDays(360);
    expect(h.tags()).toContain("renewal_reminder");
    expect(
      h.sender.outbox.find((m) => m.tag === "renewal_reminder").text,
    ).toContain("$374.40");
  });

  it("with no provider configured, webhooks are refused and nothing can be granted", async () => {
    const h = billingHarness();
    const none = new BillingEventsService(
      h.firebase,
      null,
      h.subscriptions,
      h.emails,
      new AppClock(),
    );
    await expect(none.receive("{}", "t=1,v1=x")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(await none.syncSubscription("sub_x", null)).toBe("ignored");
  });

  it("the launch trial grants TRIALING Pro until a date, then Free, and never replaces a paying plan", async () => {
    const h = billingHarness();
    h.auth.add("old", "old@example.com");
    const ends = new Date(T0 + 30 * DAY).toISOString();
    expect(await h.events.applyLaunchTrial("old", "pro", ends)).toBe("granted");
    expect(await h.subscriptions.forUser("old")).toMatchObject({
      planId: "pro",
      status: "TRIALING",
    });
    expect(h.auth.claim("old")).toBe("pro");
    await h.provider.advanceTo(T0 + 30 * DAY + 1);
    expect((await h.subscriptions.forUser("old")).planId).toBe("free");
    await h.buy("payer", "elite", "monthly");
    expect(await h.events.applyLaunchTrial("payer", "pro", ends)).toBe(
      "skipped",
    );
  });
});
