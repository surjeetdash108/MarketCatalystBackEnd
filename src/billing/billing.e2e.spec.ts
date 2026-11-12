import request from "supertest";
import { billingApp, checkoutBody } from "../../test/support/billing-app";
import { DAY, T0 } from "../../test/support/billing-harness";
import { SUBSCRIPTIONS_FLAG } from "../feature-flags/feature-flags.registry";
import { emailHash } from "./retention/email-normalise";

// Many HTTP round-trips per test; the 5 s default flakes under parallel load.
jest.setTimeout(30_000);

type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});

describe("SUBSCRIPTIONS_ENABLED and provider safety", () => {
  it("flag OFF: paid flows say launching soon and everyone keeps every built feature", async () => {
    a = await billingApp({ env: { SUBSCRIPTIONS_ENABLED: "false" } });
    const u = a.user("u1");
    const co = await u.post(
      "/api/billing/checkout",
      checkoutBody("pro", "monthly"),
    );
    expect(co.status).toBe(503);
    expect(co.body).toMatchObject({
      code: "paid_plans_unavailable",
      message: "Paid plans launching soon.",
    });
    const me = (await u.get("/api/me/entitlements")).body;
    expect(me).toMatchObject({
      subscriptionsEnabled: false,
      paidPlansAvailable: false,
      planId: "none",
    });
    expect(Object.values(me.entitlements).every(Boolean)).toBe(true);
    expect(me.entitlements.strategyLab).toBe(true);
    expect(me.limits.watchlistTickers).toBeNull();
  });

  it("flag OFF: legacy user docs (old $49.99 pro, retired plus, tier claims) keep every built feature", async () => {
    a = await billingApp({ env: { SUBSCRIPTIONS_ENABLED: "false" } });
    // The shapes found in production users docs on 2026-11-10 (counts only were read).
    const legacy = {
      legacyPro: {
        currentPlan: "pro",
        tier: "pro",
        subscriptionStatus: "ACTIVE",
      },
      legacyProNone: {
        currentPlan: "pro",
        tier: "pro",
        subscriptionStatus: "NONE",
      },
      legacyFree: {
        currentPlan: "free",
        tier: "free",
        subscriptionStatus: "NONE",
      },
      retiredPlus: {
        currentPlan: "plus",
        tier: "plus",
        subscriptionStatus: "ACTIVE",
      },
      bare: {},
    };
    for (const [uid, doc] of Object.entries(legacy)) {
      a.fs.seed("users", uid, { email: `${uid}@example.com`, ...doc });
      const me = (await a.user(uid).get("/api/me/entitlements")).body;
      expect(me.subscriptionsEnabled).toBe(false);
      expect(Object.values(me.entitlements).every(Boolean)).toBe(true);
      expect(me.limits.watchlistTickers).toBeNull();
    }
  });

  it("flag toggled at runtime (admin override) takes effect without a restart", async () => {
    a = await billingApp({ env: { SUBSCRIPTIONS_ENABLED: "false" } });
    const u = a.user("u1");
    expect(
      (await u.post("/api/billing/checkout", checkoutBody("pro", "monthly")))
        .status,
    ).toBe(503);
    await a.flags.setOverride(SUBSCRIPTIONS_FLAG, true);
    expect(
      (await u.post("/api/billing/checkout", checkoutBody("pro", "monthly")))
        .status,
    ).toBe(200);
    expect(
      (await u.get("/api/me/entitlements")).body.entitlements.strategyLab,
    ).toBe(false);
  });

  it("no provider configured: nothing can be bought or granted, and nothing is gated", async () => {
    a = await billingApp({
      provider: false,
      env: { SUBSCRIPTIONS_ENABLED: "true" },
    });
    const u = a.user("u1");
    expect(
      (await u.post("/api/billing/checkout", checkoutBody("pro", "monthly")))
        .status,
    ).toBe(503);
    expect(
      (await request(a.server).post("/api/billing/webhook").send({ id: "evt" }))
        .status,
    ).toBe(503);
    const me = (await u.get("/api/me/entitlements")).body;
    expect(me).toMatchObject({ paidPlansAvailable: false, provider: "none" });
    expect(Object.values(me.entitlements).every(Boolean)).toBe(true);
    expect((await u.get("/api/billing/fake/checkout/x")).status).toBe(404);
  });
});

describe("plan choice at signup and checkout", () => {
  const combos = [
    ["starter", "monthly", 3900],
    ["starter", "annual", 37440],
    ["pro", "monthly", 5900],
    ["pro", "annual", 56640],
    ["elite", "monthly", 19900],
    ["elite", "annual", 179100],
  ] as const;

  it.each(combos)(
    "%s %s: checkout at the catalog price → success page → active via the event handler",
    async (planId, interval, amount) => {
      a = await billingApp();
      const { checkout, complete, u } = await a.subscribe(
        "u1",
        planId,
        interval,
      );
      expect(checkout.status).toBe(200);
      expect(checkout.body).toMatchObject({
        amountDueToday: amount,
        url: expect.stringMatching(
          /^http:\/\/app\.test\/billing\/checkout\?session=cs_/,
        ),
      });
      expect(complete.body).toMatchObject({
        status: "complete",
        redirectUrl: `http://app.test/billing/success?session=${checkout.body.sessionId}`,
      });
      expect(
        (await u.get(`/api/billing/checkout/${checkout.body.sessionId}`)).body,
      ).toMatchObject({
        status: "complete",
        active: true,
        currentPlan: planId,
      });
      expect((await u.get("/api/me/entitlements")).body).toMatchObject({
        planId,
        interval,
        status: "ACTIVE",
        subscriptionsEnabled: true,
      });
      expect(a.auth.claim("u1")).toBe(planId);
    },
  );

  it("unknown or retired plans and unknown intervals are refused", async () => {
    a = await billingApp();
    const u = a.user("u1");
    expect(
      (await u.post("/api/billing/checkout", checkoutBody("plus", "monthly")))
        .body.code,
    ).toBe("unknown_plan");
    expect(
      (await u.post("/api/billing/checkout", checkoutBody("free", "monthly")))
        .body.code,
    ).toBe("unknown_plan");
    expect(
      (
        await u.post(
          "/api/billing/checkout",
          checkoutBody("pro", "weekly" as "monthly"),
        )
      ).status,
    ).toBe(400);
  });

  it("a declined card or an abandoned checkout leaves the account with no plan", async () => {
    a = await billingApp();
    const { complete, u } = await a.subscribe(
      "u1",
      "pro",
      "monthly",
      "decline",
    );
    expect(complete.body).toEqual({ status: "failed", code: "card_declined" });
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("none");
    await a.advanceDays(2);
    expect(
      a.fs.read(
        "checkout_sessions",
        (await u.get("/api/billing/summary")).body
          ? a.fs.ids("checkout_sessions")[0]
          : "",
      ),
    ).toMatchObject({ status: "expired" });
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("none");
  });

  it("3-D Secure: the challenge must be approved before the plan activates", async () => {
    a = await billingApp();
    const { complete, u } = await a.subscribe(
      "u1",
      "elite",
      "monthly",
      "requires_3ds",
    );
    expect(complete.body.status).toBe("requires_action");
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("none");
    expect(
      (
        await u.post(`/api/billing/fake/actions/${complete.body.actionId}`, {
          approve: true,
        })
      ).body.status,
    ).toBe("complete");
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("elite");
  });

  it("an existing subscriber cannot buy a second subscription", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "monthly");
    const again = await u.post(
      "/api/billing/checkout",
      checkoutBody("elite", "monthly"),
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_subscribed");
  });

  it("a promo code is validated, discounts checkout, and its redemption is recorded once", async () => {
    a = await billingApp();
    await a.admin.post("/api/admin/billing/promos", {
      code: "LAUNCH20",
      percentOff: 20,
      duration: "once",
      maxRedemptions: 1,
    });
    const u = a.user("u1");
    const preview = await u.post("/api/billing/promo/preview", {
      code: "launch20",
      planId: "pro",
      interval: "annual",
    });
    expect(preview.body).toMatchObject({
      amount: 56640,
      discountAmount: 11328,
      amountDueToday: 45312,
    });
    const { checkout } = await a.subscribe(
      "u1",
      "pro",
      "annual",
      "success",
      "LAUNCH20",
    );
    expect(checkout.body.amountDueToday).toBe(45312);
    const promo = (await a.admin.get("/api/admin/billing/promos")).body
      .promos[0];
    expect(promo.timesRedeemed).toBe(1);
    expect(
      (await a.admin.get(`/api/admin/billing/promos/${promo.id}/redemptions`))
        .body.redemptions,
    ).toEqual([
      expect.objectContaining({
        uid: "u1",
        planId: "pro",
        interval: "annual",
        code: "LAUNCH20",
      }),
    ]);
    // max redemptions now reached: the next person gets the generic error
    const second = await a.user("u2").post("/api/billing/promo/preview", {
      code: "LAUNCH20",
      planId: "pro",
      interval: "annual",
    });
    expect(second.body).toMatchObject({
      code: "promo_invalid",
      message: "This coupon is invalid",
    });
    expect(
      (
        await a
          .as("u2")
          .post(
            "/api/billing/checkout",
            checkoutBody("pro", "annual", { promoCode: "LAUNCH20" }),
          )
      ).body.code,
    ).toBe("promo_invalid");
  });
});

describe("upgrade and downgrade", () => {
  it("upgrade: preview equals the charge, applies immediately, same plan is 409", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "starter", "monthly");
    a.clock.freeze(T0 + 10 * DAY);
    expect(
      (
        await u.post("/api/billing/change/preview", {
          planId: "starter",
          interval: "monthly",
        })
      ).status,
    ).toBe(409);
    const preview = (
      await u.post("/api/billing/change/preview", {
        planId: "pro",
        interval: "monthly",
      })
    ).body;
    expect(preview).toMatchObject({ kind: "upgrade", fromPlanId: "starter" });
    const change = await u.post("/api/billing/change", {
      planId: "pro",
      interval: "monthly",
      expectedAmountDue: preview.amountDueNow,
      prorationDate: preview.prorationDate,
    });
    expect(change.body).toMatchObject({
      kind: "upgrade",
      status: "applied",
      amountCharged: preview.amountDueNow,
    });
    const invoices = (await u.get("/api/billing/invoices")).body.invoices;
    expect(invoices[0]).toMatchObject({
      amount: preview.amountDueNow,
      planId: "pro",
      status: "SUCCESS",
    });
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("pro");
    expect(a.tags()).toContain("upgrade");
  });

  it("monthly → annual is an upgrade that restarts the billing period", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "monthly");
    const p = (
      await u.post("/api/billing/change/preview", {
        planId: "pro",
        interval: "annual",
      })
    ).body;
    expect(p).toMatchObject({ kind: "upgrade", amountDueNow: 56640 - 5900 });
    await u.post("/api/billing/change", {
      planId: "pro",
      interval: "annual",
      expectedAmountDue: p.amountDueNow,
      prorationDate: p.prorationDate,
    });
    expect((await u.get("/api/me/entitlements")).body.interval).toBe("annual");
  });

  it("a stale preview and a missing preview are refused", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "starter", "monthly");
    expect(
      (
        await u.post("/api/billing/change", {
          planId: "pro",
          interval: "monthly",
        })
      ).body.code,
    ).toBe("preview_required");
    const stale = await u.post("/api/billing/change", {
      planId: "pro",
      interval: "monthly",
      expectedAmountDue: 1,
      prorationDate: T0,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("preview_stale");
  });

  it("upgrade mid-period (day 10 of 30): the breakdown equals the charge to the cent; features unlock now", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "starter", "monthly");
    a.clock.freeze(T0 + 10 * DAY);
    const p = (await u.post("/api/billing/change/preview", { planId: "pro", interval: "monthly" })).body;
    // Starter $39 → Pro $59 with 20 of 30 days left.
    expect(p.breakdown).toEqual({
      fromPlanName: "Starter",
      toPlanName: "Pro",
      periodStart: new Date(T0).toISOString(),
      today: new Date(T0 + 10 * DAY).toISOString(),
      periodEnd: new Date(T0 + 30 * DAY).toISOString(),
      usedOnCurrent: 1300, // Starter: start to today
      newPlanCharge: 3933, // Pro: today to period end
      alreadyPaid: 3900,
      discount: 0,
      tax: 0,
      creditUsed: 0,
      net: 1333,
      chargedNow: 1333,
      creditToBalance: 0,
    });
    expect(p.amountDueNow).toBe(1333);
    expect(p).toMatchObject({ nextRenewalAmount: 5900, nextRenewalDate: new Date(T0 + 30 * DAY).toISOString() });
    const r = await u.post("/api/billing/change", { planId: "pro", interval: "monthly", expectedAmountDue: 1333, prorationDate: p.prorationDate });
    expect(r.body).toMatchObject({ kind: "upgrade", status: "applied", amountCharged: 1333 });
    expect((await u.get("/api/me/entitlements")).body.entitlements.moneyFlow).toBe(true);
  });

  it("downgrade mid-period (day 10 of 30): applies now, credit to the account equals the breakdown, used on the next invoice", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "elite", "monthly");
    a.clock.freeze(T0 + 10 * DAY);
    const p = (await u.post("/api/billing/change/preview", { planId: "starter", interval: "monthly" })).body;
    // Elite $199 → Starter $39 with 20 of 30 days left.
    expect(p.kind).toBe("downgrade");
    expect(p.breakdown).toMatchObject({
      fromPlanName: "Elite",
      toPlanName: "Starter",
      usedOnCurrent: 6633, // 19900 − unused 13267
      newPlanCharge: 2600,
      alreadyPaid: 19900,
      net: -10667,
      chargedNow: 0,
      creditToBalance: 10667,
    });
    expect(p.breakdown.usedOnCurrent + p.breakdown.newPlanCharge - p.breakdown.alreadyPaid).toBe(-p.creditToBalance);
    expect(p).toMatchObject({ amountDueNow: 0, creditToBalance: 10667, creditBalanceAfter: 10667, nextInvoiceAfterCredit: 0 });
    // A downgrade also needs the preview, and the credit must match it exactly.
    expect((await u.post("/api/billing/change", { planId: "starter", interval: "monthly" })).body.code).toBe("preview_required");
    expect((await u.post("/api/billing/change", { planId: "starter", interval: "monthly", expectedCredit: 10666, prorationDate: p.prorationDate })).body.code).toBe("preview_stale");
    const r = await u.post("/api/billing/change", { planId: "starter", interval: "monthly", expectedCredit: 10667, prorationDate: p.prorationDate });
    expect(r.body).toMatchObject({ kind: "downgrade", status: "applied", amountCharged: 0, creditToBalance: 10667 });
    // Features drop now.
    const me = (await u.get("/api/me/entitlements")).body;
    expect(me.planId).toBe("starter");
    expect(me.entitlements.strategyLab).toBe(false);
    expect((await u.get("/api/billing/summary")).body).toMatchObject({ planId: "starter", creditBalance: 10667, scheduledChange: null });
    // The credit pays the next invoices automatically: 3900 at renewal, then 3900, then the remaining 2867 credit.
    await a.advanceDays(21);
    let inv = (await u.get("/api/billing/invoices")).body.invoices[0];
    expect(inv).toMatchObject({ planId: "starter", amount: 0, creditApplied: 3900 });
    await a.advanceDays(30);
    await a.advanceDays(31);
    inv = (await u.get("/api/billing/invoices")).body.invoices[0];
    expect(inv).toMatchObject({ amount: 3900 - (10667 - 7800), creditApplied: 10667 - 7800 });
    expect((await u.get("/api/billing/summary")).body.creditBalance).toBe(0);
  });

  it("annual → monthly is still scheduled for the end of the annual period; 'keep my current plan' cancels it", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "elite", "annual");
    const p = (await u.post("/api/billing/change/preview", { planId: "pro", interval: "monthly" })).body;
    expect(p).toMatchObject({ kind: "scheduled", amountDueNow: 0, creditToBalance: 0, breakdown: null });
    expect((await u.post("/api/billing/change", { planId: "pro", interval: "monthly" })).body).toMatchObject({ status: "scheduled" });
    expect((await u.get("/api/billing/summary")).body.scheduledChange).toMatchObject({ planId: "pro", interval: "monthly" });
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("elite");
    expect((await u.post("/api/billing/change/keep")).body).toMatchObject({ kept: true, planId: "elite" });
    await u.post("/api/billing/change", { planId: "pro", interval: "monthly" });
    await a.advanceDays(364);
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("elite");
    await a.advanceDays(2);
    expect((await u.get("/api/me/entitlements")).body).toMatchObject({ planId: "pro", interval: "monthly" });
    expect((await u.get("/api/billing/invoices")).body.invoices[0]).toMatchObject({ amount: 5900, planId: "pro" });
  });

  it("downgrade edge case: a retention discount continues at 50% of the new price for its remaining months", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "elite", "monthly");
    await u.post("/api/billing/cancel");
    await u.post("/api/billing/retention/accept"); // 50% off the next 2 invoices
    await a.advanceDays(31); // first discounted invoice: 9950
    a.clock.freeze(Date.parse((await u.get("/api/billing/summary")).body.currentPeriodStart ?? new Date(T0).toISOString()) + 10 * DAY);
    const p = (await u.post("/api/billing/change/preview", { planId: "pro", interval: "monthly" })).body;
    expect(p.breakdown.alreadyPaid).toBe(9950);
    await u.post("/api/billing/change", { planId: "pro", interval: "monthly", expectedCredit: p.creditToBalance, prorationDate: p.prorationDate });
    await a.advanceDays(31);
    const inv = (await u.get("/api/billing/invoices")).body.invoices[0];
    expect(inv).toMatchObject({ planId: "pro", discountAmount: 2950 }); // 50% of 5900
    await a.advanceDays(31);
    expect((await u.get("/api/billing/invoices")).body.invoices[0]).toMatchObject({ planId: "pro", discountAmount: 0 });
  });

  it("downgrade edge case: while cancelling, the downgrade applies now and keeps the cancel date", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "monthly");
    await u.post("/api/billing/cancel");
    const before = (await u.get("/api/billing/summary")).body;
    expect(before.cancelAtPeriodEnd).toBe(true);
    const p = (await u.post("/api/billing/change/preview", { planId: "starter", interval: "monthly" })).body;
    expect(p.keepsCancelDate).toBe(true);
    await u.post("/api/billing/change", { planId: "starter", interval: "monthly", expectedCredit: p.creditToBalance, prorationDate: p.prorationDate });
    const after = (await u.get("/api/billing/summary")).body;
    expect(after).toMatchObject({ planId: "starter", cancelAtPeriodEnd: true, currentPeriodEnd: before.currentPeriodEnd });
  });

  it("downgrade edge case: past due is refused until paid", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "monthly", "renewal_failure");
    await a.advanceDays(31);
    const r = await u.post("/api/billing/change/preview", { planId: "starter", interval: "monthly" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("past_due");
  });

  it("upgrading while an annual → monthly change is scheduled drops it; while cancelling, it resumes", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "annual");
    await u.post("/api/billing/change", { planId: "pro", interval: "monthly" });
    let p = (await u.post("/api/billing/change/preview", { planId: "elite", interval: "annual" })).body;
    expect(p.cancelsPendingDowngrade).toBe(true);
    await u.post("/api/billing/change", { planId: "elite", interval: "annual", expectedAmountDue: p.amountDueNow, prorationDate: p.prorationDate });
    let s = (await u.get("/api/billing/summary")).body;
    expect(s).toMatchObject({ planId: "elite", scheduledChange: null });
    await u.post("/api/billing/cancel");
    a.clock.freeze(a.clock.now() + DAY);
    const sub = await a.subscribe("u2", "starter", "monthly");
    await sub.u.post("/api/billing/cancel");
    p = (await sub.u.post("/api/billing/change/preview", { planId: "pro", interval: "monthly" })).body;
    expect(p.resumesCancelledPlan).toBe(true);
    await sub.u.post("/api/billing/change", { planId: "pro", interval: "monthly", expectedAmountDue: p.amountDueNow, prorationDate: p.prorationDate });
    s = (await sub.u.get("/api/billing/summary")).body;
    expect(s).toMatchObject({ planId: "pro", cancelAtPeriodEnd: false });
  });

  it("history: payment records carry line items (description, period, amount, proration, credits); older records show totals", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "elite", "monthly");
    a.clock.freeze(T0 + 10 * DAY);
    const p = (await u.post("/api/billing/change/preview", { planId: "starter", interval: "monthly" })).body;
    await u.post("/api/billing/change", { planId: "starter", interval: "monthly", expectedCredit: p.creditToBalance, prorationDate: p.prorationDate });
    const invs = (await u.get("/api/billing/invoices")).body.invoices;
    const change = invs.find((i: { reason: string }) => i.reason === "subscription_update");
    expect(change.lines).toEqual([
      { description: "Unused time on elite (monthly)", amount: -13267, proration: true, periodStart: new Date(T0 + 10 * DAY).toISOString(), periodEnd: new Date(T0 + 30 * DAY).toISOString() },
      { description: "Remaining time on starter (monthly)", amount: 2600, proration: true, periodStart: new Date(T0 + 10 * DAY).toISOString(), periodEnd: new Date(T0 + 30 * DAY).toISOString() },
      { description: "Credit to your account balance", amount: 10667, proration: false, periodStart: null, periodEnd: null },
    ]);
    const first = invs.find((i: { reason: string }) => i.reason === "subscription_create");
    expect(first.lines[0]).toMatchObject({ amount: 19900, proration: false });
    await a.advanceDays(21);
    const renewal = (await u.get("/api/billing/invoices")).body.invoices[0];
    expect(renewal.lines).toEqual(expect.arrayContaining([expect.objectContaining({ description: "Account credit applied", amount: -3900 })]));
    // A record written before lines were stored shows its totals as before.
    a.fs.seed("payments", "in_old", { paymentId: "in_old", userId: "u1", planId: "elite", amount: 19900, paymentStatus: "SUCCESS", paymentDate: "2026-01-01T00:00:00.000Z" });
    const old = (await u.get("/api/billing/invoices")).body.invoices.find((i: { id: string }) => i.id === "in_old");
    expect(old).toMatchObject({ amount: 19900, lines: null });
  });

  it("changing plan while past due is refused until the card is fixed", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "monthly", "renewal_failure");
    await a.advanceDays(31);
    const r = await u.post("/api/billing/change/preview", {
      planId: "elite",
      interval: "monthly",
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("past_due");
    expect((await u.get("/api/me/entitlements")).body).toMatchObject({
      planId: "pro",
      inGrace: true,
    });
  });

  it("an upgrade with a declined card changes nothing (402)", async () => {
    a = await billingApp();
    const { u } = await a.subscribe(
      "u1",
      "starter",
      "monthly",
      "renewal_failure",
    );
    const p = (
      await u.post("/api/billing/change/preview", {
        planId: "pro",
        interval: "monthly",
      })
    ).body;
    const r = await u.post("/api/billing/change", {
      planId: "pro",
      interval: "monthly",
      expectedAmountDue: p.amountDueNow,
      prorationDate: p.prorationDate,
    });
    expect(r.status).toBe(402);
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("starter");
  });
});

describe("cancel anytime", () => {
  it.each([["monthly"], ["annual"]] as const)(
    "%s: cancel at period end, exact end date shown, no plan after it",
    async (interval) => {
      a = await billingApp();
      const { u } = await a.subscribe("u1", "pro", interval);
      const end = (await u.get("/api/billing/summary")).body.currentPeriodEnd;
      const c = await u.post("/api/billing/cancel");
      expect(c.body).toMatchObject({ cancelAtPeriodEnd: true, endsAt: end });
      expect((await u.get("/api/billing/summary")).body).toMatchObject({
        endsAt: end,
        renewsAt: null,
        cancelAtPeriodEnd: true,
      });
      await a.admin.post("/api/billing/fake/clock/advance", {
        to: new Date(Date.parse(end) - 1000).toISOString(),
      });
      expect((await u.get("/api/me/entitlements")).body.planId).toBe("pro");
      await a.admin.post("/api/billing/fake/clock/advance", { to: end });
      expect((await u.get("/api/me/entitlements")).body).toMatchObject({
        planId: "none",
        status: "CANCELLED",
      });
      expect((await u.get("/api/billing/invoices")).body.invoices.length).toBe(
        1,
      );
    },
  );

  it("resume before the end date keeps the plan renewing; after the end it is refused", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "monthly");
    await u.post("/api/billing/cancel");
    expect((await u.post("/api/billing/resume")).body.resumed).toBe(true);
    await a.advanceDays(31);
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("pro");
    await u.post("/api/billing/cancel");
    await a.advanceDays(31);
    expect((await u.post("/api/billing/resume")).status).toBe(409);
  });
});

describe("retention offer", () => {
  it("monthly: offered once, 50% off the next 2 invoices then full price, pending cancel cleared", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "monthly");
    const offer = (await u.get("/api/billing/retention")).body;
    expect(offer).toMatchObject({
      eligible: true,
      offer: {
        mode: "percent_next_invoices",
        percentOff: 50,
        months: 2,
        headline:
          "Before you go: 50% off for the next 2 months. Still want to cancel?",
      },
    });
    await u.post("/api/billing/cancel");
    expect((await u.post("/api/billing/retention/accept")).body).toMatchObject({
      applied: true,
    });
    expect((await u.get("/api/billing/summary")).body).toMatchObject({
      cancelAtPeriodEnd: false,
      discount: { source: "retention" },
    });
    const amounts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await a.advanceDays(31);
      amounts.push(
        (await u.get("/api/billing/invoices")).body.invoices[0].amount,
      );
    }
    expect(amounts).toEqual([2950, 2950, 5900]);
    expect(a.tags()).toContain("retention_accepted");
    // record in our collection AND in provider customer metadata
    expect(
      a.fs.read("retention_offers", emailHash("u1@example.com")),
    ).toMatchObject({ uid: "u1", mode: "percent_next_invoices" });
    const cust = await a.provider.getCustomer(
      a.fs.read("customers", "u1").customerId as string,
    );
    expect(cust.metadata).toMatchObject({
      retention_offer_used: "true",
      retention_email_hash: emailHash("u1@example.com"),
    });
    // second cancel attempt: no offer
    expect((await u.get("/api/billing/retention")).body).toEqual({
      eligible: false,
      reason: "already_used",
    });
    expect((await u.post("/api/billing/retention/accept")).status).toBe(409);
  });

  it("annual: credit = annual price ÷ 12 × 2 × 50% on the next invoice", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "annual");
    const offer = (await u.get("/api/billing/retention")).body.offer;
    expect(offer).toMatchObject({ mode: "balance_credit", creditAmount: 4720 });
    await u.post("/api/billing/retention/accept");
    expect((await u.get("/api/billing/summary")).body.nextCharge).toMatchObject(
      { amount: 56640 - 4720, creditApplied: 4720 },
    );
    await a.advanceDays(366);
    expect(
      (await u.get("/api/billing/invoices")).body.invoices[0],
    ).toMatchObject({ amount: 51920, creditApplied: 4720 });
  });

  it("once per email ever: a new account with the same email (or a gmail variant) gets no offer", async () => {
    a = await billingApp();
    const first = await a.subscribe(
      "old-uid",
      "pro",
      "monthly",
      "success",
      undefined,
      "Jane.Doe+trading@gmail.com",
    );
    await first.u.post("/api/billing/retention/accept");
    // account deleted and re-created: different uid, same address in other spellings
    for (const [uid, email] of [
      ["new-uid", "jane.doe@gmail.com"],
      ["new-uid-2", "JaneDoe@googlemail.com"],
      ["new-uid-3", " j.a.n.e.d.o.e+x@GMAIL.com "],
    ]) {
      const { u } = await a.subscribe(
        uid,
        "starter",
        "monthly",
        "success",
        undefined,
        email,
      );
      expect((await u.get("/api/billing/retention")).body).toEqual({
        eligible: false,
        reason: "already_used",
      });
    }
    // a different person is still offered it
    const other = await a.subscribe(
      "other",
      "starter",
      "monthly",
      "success",
      undefined,
      "jane.doe.other@gmail.com",
    );
    expect((await other.u.get("/api/billing/retention")).body.eligible).toBe(
      true,
    );
  });

  it("not shown while a ≥50% discount is active; replaces a weaker promo (no stacking)", async () => {
    a = await billingApp();
    await a.admin.post("/api/admin/billing/promos", {
      code: "HALF",
      percentOff: 50,
      duration: "repeating",
      durationInMonths: 6,
    });
    await a.admin.post("/api/admin/billing/promos", {
      code: "TEN",
      percentOff: 10,
      duration: "forever",
    });
    const half = await a.subscribe("u1", "pro", "monthly", "success", "HALF");
    expect((await half.u.get("/api/billing/retention")).body).toEqual({
      eligible: false,
      reason: "discount_already_50",
    });
    const ten = await a.subscribe("u2", "pro", "monthly", "success", "TEN");
    expect((await ten.u.get("/api/billing/retention")).body.eligible).toBe(
      true,
    );
    await ten.u.post("/api/billing/retention/accept");
    await a.advanceDays(31);
    expect(
      (await ten.u.get("/api/billing/invoices")).body.invoices[0].amount,
    ).toBe(2950); // 50%, not 50% + 10%
  });
});

describe("billing page", () => {
  it("shows plan, next charge, renewal date, invoices with downloads, history, and opens the portal", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "starter", "monthly");
    const s = (await u.get("/api/billing/summary")).body;
    expect(s).toMatchObject({
      planId: "starter",
      status: "ACTIVE",
      interval: "monthly",
      nextCharge: { amount: 3900 },
      renewsAt: s.currentPeriodEnd,
      hasBillingAccount: true,
    });
    const inv = (await u.get("/api/billing/invoices")).body.invoices;
    expect(inv).toEqual([
      expect.objectContaining({
        amount: 3900,
        status: "SUCCESS",
        documentPath: expect.stringMatching(/^\/api\/billing\/invoices\/in_/),
      }),
    ]);
    const doc = await u.get(inv[0].documentPath);
    expect(doc.status).toBe(200);
    expect(doc.headers["content-disposition"]).toMatch(/attachment/);
    expect(doc.text).toContain("Receipt");
    expect((await a.user("intruder").get(inv[0].documentPath)).status).toBe(
      404,
    );
    expect(
      (await u.get("/api/billing/history")).body.history.map(
        (h: { type: string }) => h.type,
      ),
    ).toEqual(["subscribed"]);
    const portal = (await u.post("/api/billing/portal")).body;
    expect(portal.url).toMatch(
      /^http:\/\/app\.test\/billing\/portal\?session=bps_/,
    );
  });

  it("portal card update pays an overdue invoice and ends the grace period", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "pro", "monthly", "renewal_failure");
    await a.advanceDays(31);
    expect((await u.get("/api/billing/summary")).body).toMatchObject({
      status: "PAST_DUE",
      inGrace: true,
    });
    const session = new URL(
      (await u.post("/api/billing/portal")).body.url,
    ).searchParams.get("session");
    expect(
      (
        await u.post(`/api/billing/fake/portal/${session}/card`, {
          card: "success",
        })
      ).body,
    ).toEqual({ retried: 1, paid: 1 });
    expect((await u.get("/api/billing/summary")).body).toMatchObject({
      status: "ACTIVE",
      inGrace: false,
    });
  });
});

describe("webhook endpoint", () => {
  it("rejects unsigned/tampered events (400), processes signed ones once", async () => {
    a = await billingApp();
    await a.subscribe("u1", "pro", "monthly");
    const event = (await a.provider.listEvents())[0];
    const raw = JSON.stringify(event);
    expect(
      (
        await request(a.server)
          .post("/api/billing/webhook")
          .set("content-type", "application/json")
          .send(raw)
      ).status,
    ).toBe(400);
    const tampered = raw.replace("checkout.completed", "subscription.deleted");
    expect(
      (
        await request(a.server)
          .post("/api/billing/webhook")
          .set("content-type", "application/json")
          .set("x-billing-signature", a.provider.sign(raw))
          .send(tampered)
      ).status,
    ).toBe(400);
    const ok = await request(a.server)
      .post("/api/billing/webhook")
      .set("content-type", "application/json")
      .set("x-billing-signature", a.provider.sign(raw))
      .send(raw);
    expect(ok.body).toEqual({ received: true, result: "duplicate" }); // already processed in-process
  });
});

describe("nightly reconcile", () => {
  it("repairs a mirror that drifted from the provider", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("u1", "elite", "monthly");
    a.fs.seed("subscriptions", "u1", {
      ...a.fs.read("subscriptions", "u1"),
      planId: "starter",
      status: "CANCELLED",
    });
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("none");
    const r = await a.admin.post("/api/admin/billing/reconcile");
    expect(r.body.repaired).toEqual([
      { uid: "u1", fields: ["planId", "status"] },
    ]);
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("elite");
    expect(
      (await a.admin.post("/api/admin/billing/reconcile")).body.repaired,
    ).toEqual([]);
  });
});
