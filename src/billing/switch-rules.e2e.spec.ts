import { billingApp } from "../../test/support/billing-app";
import { billingHarness, DAY, T0 } from "../../test/support/billing-harness";
import { classifyChange } from "./billing.service";
import { CreditsService } from "./credits/credits.service";
import { AppClock } from "../common/app-clock";
import { emailHash } from "./retention/email-normalise";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";

jest.setTimeout(30_000);

type App = Awaited<ReturnType<typeof billingApp>>;
let a: App | undefined;
afterEach(async () => {
  await a?.close();
  a = undefined;
});

describe("switch rules (Starter < Pro < Elite)", () => {
  it("a higher plan switches now whatever the billing period; a lower plan at renewal; same plan: annual now, monthly at renewal", () => {
    const k = (from: string, fi: "monthly" | "annual", to: string, ti: "monthly" | "annual") =>
      classifyChange({ planId: from, interval: fi }, { planId: to, interval: ti });
    // higher plan → now, any interval combination
    expect(k("starter", "monthly", "pro", "monthly")).toBe("upgrade");
    expect(k("starter", "monthly", "elite", "annual")).toBe("upgrade");
    expect(k("pro", "annual", "elite", "monthly")).toBe("upgrade");
    expect(k("starter", "annual", "pro", "annual")).toBe("upgrade");
    // lower plan → at renewal, any interval combination
    expect(k("elite", "monthly", "pro", "monthly")).toBe("scheduled");
    expect(k("elite", "monthly", "pro", "annual")).toBe("scheduled");
    expect(k("elite", "annual", "starter", "monthly")).toBe("scheduled");
    expect(k("pro", "annual", "starter", "annual")).toBe("scheduled");
    // same plan
    expect(k("pro", "monthly", "pro", "annual")).toBe("upgrade");
    expect(k("pro", "annual", "pro", "monthly")).toBe("scheduled");
    expect(k("pro", "monthly", "pro", "monthly")).toBe("same");
  });

  it("Pro annual → Elite monthly switches now; the unused annual value becomes Market Catalyst credits (not spent automatically)", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "annual");
    a.clock.freeze(T0 + 30 * DAY);
    const p = (await u.post("/api/billing/change/preview", { planId: "elite", interval: "monthly" })).body;
    expect(p).toMatchObject({ kind: "upgrade", amountDueNow: 0 });
    expect(p.leftoverToCredits).toBeGreaterThan(0);
    const r = (await u.post("/api/billing/change", { planId: "elite", interval: "monthly", expectedAmountDue: 0, prorationDate: p.prorationDate })).body;
    expect(r).toMatchObject({ status: "applied", creditToBalance: p.leftoverToCredits });
    const s = (await u.get("/api/billing/summary")).body;
    expect(s).toMatchObject({ planId: "elite", interval: "monthly" });
    expect(s.credits).toMatchObject({ balance: p.leftoverToCredits, available: p.leftoverToCredits, pending: 0 });
    // Not left in the provider's own balance, where it would pay the next invoice by itself.
    expect(s.creditBalance).toBe(0);
  });

  it("Elite monthly → Pro annual: Elite continues to renewal, then the first charge is Pro annual", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "elite", "monthly");
    a.clock.freeze(T0 + 10 * DAY);
    const p = (await u.post("/api/billing/change/preview", { planId: "pro", interval: "annual" })).body;
    expect(p).toMatchObject({ kind: "scheduled", amountDueNow: 0 });
    expect((await u.post("/api/billing/change", { planId: "pro", interval: "annual" })).body.status).toBe("scheduled");
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("elite");
    expect((await u.get("/api/billing/summary")).body.scheduledChange).toMatchObject({ planId: "pro", interval: "annual" });
    await a.advanceDays(25);
    const inv = (await u.get("/api/billing/invoices")).body.invoices[0];
    expect(inv).toMatchObject({ planId: "pro", interval: "annual", amount: 56640 });
  });

  it("cancel, then resume, brings the scheduled switch back", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "elite", "monthly");
    await u.post("/api/billing/change", { planId: "pro", interval: "monthly" });
    await u.post("/api/billing/cancel");
    expect((await u.get("/api/billing/summary")).body.scheduledChange).toBeNull();
    await u.post("/api/billing/resume");
    const s = (await u.get("/api/billing/summary")).body;
    expect(s.cancelAtPeriodEnd).toBe(false);
    expect(s.scheduledChange).toMatchObject({ planId: "pro", interval: "monthly" });
  });

  it("a full refund of the current period's payment ends access straight away", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "monthly");
    const inv = (await u.get("/api/billing/invoices")).body.invoices[0];
    await a.provider.refundInvoice(inv.id);
    const after = (await u.get("/api/billing/invoices")).body.invoices[0];
    expect(after).toMatchObject({ status: "REFUNDED", amountRefunded: inv.amount });
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("none");
  });

  it("a partial refund records the amount and keeps the plan", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "monthly");
    const inv = (await u.get("/api/billing/invoices")).body.invoices[0];
    await a.provider.refundInvoice(inv.id, 1000);
    expect((await u.get("/api/billing/invoices")).body.invoices[0]).toMatchObject({ status: "SUCCESS", amountRefunded: 1000 });
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("pro");
  });

  it("previewing a referral code doesn't attach the referrer; checking out with it does", async () => {
    a = await billingApp();
    const { u: member } = await a.subscribe("ref", "pro", "monthly");
    const code = (await member.get("/api/billing/referral")).body.code as string;
    const friend = a.user("friend");
    expect((await friend.post("/api/billing/promo/preview", { code, planId: "pro", interval: "monthly" })).status).toBe(200);
    expect(a.fs.read("referral_attributions", "friend")).toBeUndefined();
    await a.subscribe("friend", "pro", "monthly", "success", code);
    expect(a.fs.read("referral_attributions", "friend")).toMatchObject({ referrerUid: "ref", code });
  });

  it("the first payment is remembered by email (deleting the account and signing up again isn't a first-time customer)", async () => {
    a = await billingApp();
    await a.subscribe("u1", "pro", "monthly");
    expect(a.fs.read("paid_emails", emailHash("u1@example.com"))).toMatchObject({ uid: "u1" });
  });
});

describe("webhooks for unpaid checkouts", () => {
  const sub = (over: Record<string, unknown>) => ({
    id: "sub_A", customerId: "cus_1", uid: "newbie", planId: "pro", interval: "monthly",
    priceLookupKey: "pro_monthly", amount: 5900, currency: "USD", status: "incomplete",
    startedAt: new Date(T0).toISOString(), currentPeriodStart: new Date(T0).toISOString(),
    currentPeriodEnd: new Date(T0 + 30 * DAY).toISOString(), cancelAtPeriodEnd: false, canceledAt: null,
    endedAt: null, discount: null, scheduledChange: null, pastDueSince: null, latestInvoiceId: null,
    updatedAt: Date.now(), ...over,
  });

  it("the first event about an unpaid checkout doesn't crash", async () => {
    const h = billingHarness();
    h.auth.add("newbie", "newbie@example.com");
    await expect(h.events.applySubscription(sub({}) as never, null)).resolves.toBe("processed");
  });

  it("an abandoned checkout sends no 'plan ended' email and writes no history", async () => {
    const h = billingHarness();
    h.auth.add("newbie", "newbie@example.com");
    await h.events.applySubscription(sub({}) as never, null);
    const before = h.tags().length;
    await h.events.applySubscription(sub({ status: "canceled", endedAt: new Date(T0 + DAY).toISOString(), updatedAt: Date.now() + 1000 }) as never, null);
    expect(h.tags().slice(before)).not.toContain("plan_ended");
    expect(h.fs.ids("subscription_events").length).toBe(0);
  });

  it("an older unpaid checkout being closed doesn't replace the newer one waiting for payment", async () => {
    const h = billingHarness();
    h.auth.add("newbie", "newbie@example.com");
    await h.events.applySubscription(sub({ id: "sub_new" }) as never, null);
    expect(await h.events.applySubscription(sub({ id: "sub_old", status: "canceled", updatedAt: Date.now() + 1000 }) as never, null)).toBe("ignored");
    expect(h.fs.read("subscriptions", "newbie")).toMatchObject({ subscriptionId: "sub_new" });
  });

  it("an unpaid checkout doesn't end the 7-day intro", async () => {
    const h = billingHarness();
    h.auth.add("newbie", "newbie@example.com");
    await h.fs.collection("users").doc("newbie").set({ createdAt: new Date(T0 - DAY).toISOString(), email: "newbie@example.com" });
    expect((await h.subscriptions.forUser("newbie")).status).toBe("INTRO");
    await h.events.applySubscription(sub({}) as never, null);
    expect((await h.subscriptions.forUser("newbie")).status).toBe("INTRO");
  });

  it("a trial converting to paid stays open for a short grace (no 'Choose a plan' flash); a cancelled trial ends exactly", async () => {
    const h = billingHarness();
    const end = new Date(T0).toISOString();
    h.clock.freeze(T0 + 10 * 60_000);
    const live = await h.subscriptions.resolve("t1", {}, { uid: "t1", planId: "pro", status: "TRIALING", currentPeriodEnd: end, cancelAtPeriodEnd: false });
    expect(live.entitled).toBe(true);
    const cancelled = await h.subscriptions.resolve("t1", {}, { uid: "t1", planId: "pro", status: "TRIALING", currentPeriodEnd: end, cancelAtPeriodEnd: true });
    expect(cancelled.entitled).toBe(false);
  });
});

describe("Market Catalyst credits", () => {
  const credits = () => {
    const h = billingHarness();
    const svc = new CreditsService({ firestore: h.fs } as unknown as FirebaseAdminService, h.clock as AppClock);
    return { h, svc };
  };

  it("added once per key; reserved on opt-in; leave the balance only when spent", async () => {
    const { svc } = credits();
    await svc.add("u1", 5000, "switch", "k1");
    await svc.add("u1", 5000, "switch", "k1"); // same key: once
    expect((await svc.get("u1")).balance).toBe(5000);
    expect(await svc.reserve("u1", 3000, "sub_1")).toBe(3000);
    expect(await svc.available("u1")).toBe(2000);
    expect(await svc.settle("u1", "sub_1", 3000, "invoice")).toBe(3000);
    expect(await svc.get("u1")).toMatchObject({ balance: 2000, pending: null });
  });

  it("a reservation that isn't spent is released back", async () => {
    const { svc } = credits();
    await svc.add("u1", 5000, "switch", "k1");
    await svc.reserve("u1", 9999, "sub_1");
    expect(await svc.available("u1")).toBe(0);
    await svc.release("u1", "payment failed");
    expect(await svc.get("u1")).toMatchObject({ balance: 5000, pending: null });
    expect(await svc.available("u1")).toBe(5000);
  });

  it("spending on a different subscription than the reservation is ignored", async () => {
    const { svc } = credits();
    await svc.add("u1", 5000, "switch", "k1");
    await svc.reserve("u1", 5000, "sub_1");
    expect(await svc.settle("u1", "sub_other", 5000, "invoice")).toBe(0);
    expect((await svc.get("u1")).balance).toBe(5000);
  });
});
