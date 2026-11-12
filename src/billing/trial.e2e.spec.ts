import { billingApp, checkoutBody } from "../../test/support/billing-app";
import { DAY, T0 } from "../../test/support/billing-harness";
import { CONSENT_VERSION, consentText } from "./checkout/consent";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});
const trialApp = () => billingApp({ env: { TRIAL_DAYS: "7" } });
const OR = { country: "US", state: "OR", postalCode: "97201" };

describe("7-day free trial on every plan (once per email, card required)", () => {
  it.each([["starter"], ["pro"], ["elite"]])("%s: the preview shows $0 today, the first charge and when, and trial consent text", async (planId) => {
    a = await trialApp();
    const p = (await a.user("t1").post("/api/billing/checkout/preview", { planId, interval: "monthly", region: OR })).body;
    const price = { starter: 3900, pro: 5900, elite: 19900 }[planId]!;
    expect(p).toMatchObject({
      trial: { days: 7, endsAt: new Date(T0 + 7 * DAY).toISOString() },
      dueToday: 0,
      firstCharge: { amount: price, at: new Date(T0 + 7 * DAY).toISOString() },
      total: price,
      renewsAt: new Date(T0 + 7 * DAY).toISOString(),
      consent: { version: CONSENT_VERSION, text: consentText(planId, "monthly", 7) },
    });
    expect(p.consent.text).toMatch(/after my 7-day free trial .* If I cancel before the trial ends I pay nothing\./);
  });

  it("checkout: nothing charged today, Pro unlocks now, the trial-started email, then the full price at day 7", async () => {
    a = await trialApp();
    const { checkout, complete, u } = await a.subscribe("t2", "pro", "monthly");
    expect(checkout.body.amountDueToday).toBe(0);
    expect(complete?.status).toBe(200);
    const me = (await u.get("/api/me/entitlements")).body;
    expect(me).toMatchObject({ planId: "pro", status: "TRIALING" });
    expect(me.entitlements.moneyFlow).toBe(true);
    let inv = (await u.get("/api/billing/invoices")).body.invoices[0];
    expect(inv).toMatchObject({ amount: 0, status: "SUCCESS" });
    expect(inv.lines[0]).toMatchObject({ description: "Free trial (7 days)", amount: 0 });
    const welcome = a.sender.outbox.find((m) => m.tag === "welcome")!;
    expect(welcome.subject).toBe("Your Pro free trial has started");
    await a.advanceDays(8);
    inv = (await u.get("/api/billing/invoices")).body.invoices[0];
    expect(inv).toMatchObject({ amount: 5900, planId: "pro" });
    expect((await u.get("/api/me/entitlements")).body).toMatchObject({ planId: "pro", status: "ACTIVE" });
  });

  it("once per email ever: a second account with the same inbox (gmail variant) gets no trial and pays today", async () => {
    a = await trialApp();
    await a.subscribe("first", "starter", "monthly", "success", undefined, "trial.person@gmail.com");
    const second = a.user("second", "TrialPerson+x@googlemail.com");
    const p = (await second.post("/api/billing/checkout/preview", { planId: "starter", interval: "monthly" })).body;
    expect(p.trial).toBeNull();
    expect(p.dueToday).toBe(p.total);
    const { checkout } = await a.subscribe("second", "starter", "monthly");
    expect(checkout.body.amountDueToday).toBeGreaterThan(0);
    expect((a.fs.read("checkout_sessions", checkout.body.sessionId)?.consent as { text: string }).text).toBe(consentText("starter", "monthly", 0));
  });

  it("cancel during the trial: never charged, access ends when the trial ends", async () => {
    a = await trialApp();
    const { u } = await a.subscribe("t3", "elite", "annual");
    await u.post("/api/billing/cancel");
    await a.advanceDays(8);
    const invs = (await u.get("/api/billing/invoices")).body.invoices;
    expect(invs.every((i: { amount: number }) => i.amount === 0)).toBe(true);
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("none");
  });

  it("upgrade during the trial: $0 now, the new plan unlocks, its price is the first charge at the trial's end", async () => {
    a = await trialApp();
    const { u } = await a.subscribe("t4", "starter", "monthly");
    a.clock.freeze(T0 + 2 * DAY);
    const p = (await u.post("/api/billing/change/preview", { planId: "pro", interval: "monthly" })).body;
    expect(p).toMatchObject({ kind: "upgrade", amountDueNow: 0 });
    await u.post("/api/billing/change", { planId: "pro", interval: "monthly", expectedAmountDue: 0, prorationDate: p.prorationDate });
    expect((await u.get("/api/me/entitlements")).body).toMatchObject({ planId: "pro", status: "TRIALING" });
    await a.advanceDays(6);
    expect((await u.get("/api/billing/invoices")).body.invoices[0]).toMatchObject({ amount: 5900, planId: "pro" });
  });

  it("an account that has already paid gets no trial", async () => {
    a = await billingApp(); // TRIAL_DAYS 0 for the first purchase
    await a.subscribe("paid", "starter", "monthly");
    a.fs.seed("customers", "paid", { ...(a.fs.read("customers", "paid") ?? {}), firstPaidAt: new Date(T0).toISOString() });
    const withTrials = await billingApp({ env: { TRIAL_DAYS: "7" } });
    try {
      withTrials.fs.seed("customers", "paid", { uid: "paid", firstPaidAt: new Date(T0).toISOString() });
      const p = (await withTrials.user("paid").post("/api/billing/checkout/preview", { planId: "pro", interval: "monthly" })).body;
      expect(p.trial).toBeNull();
    } finally {
      await withTrials.close();
    }
    void checkoutBody;
  });
});
