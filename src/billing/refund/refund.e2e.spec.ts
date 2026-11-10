import { billingApp } from "../../../test/support/billing-app";

jest.setTimeout(60_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});

describe("refunds (REFUND_WINDOW_DAYS = 14)", () => {
  it("first payment within the window: full refund, plan ends now → Free, email sent, claim recorded", async () => {
    a = await billingApp({ env: { SUBSCRIPTIONS_ENABLED: "true" } });
    const { u } = await a.subscribe("r1", "pro", "monthly");
    await a.advanceDays(3);
    const e = (await u.get("/api/billing/refund")).body;
    expect(e).toMatchObject({
      eligible: true,
      kind: "first_payment",
      amount: 5900,
      windowDays: 14,
    });
    const r = await u.post("/api/billing/refund");
    expect(r.body).toEqual({
      refunded: true,
      amount: 5900,
      currency: "USD",
      kind: "first_payment",
    });
    const pay = (
      await a.fs.collection("payments").where("userId", "==", "r1").get()
    ).docs[0].data();
    expect(pay).toMatchObject({
      paymentStatus: "REFUNDED",
      amountRefunded: 5900,
    });
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("free");
    expect(a.fs.read("subscriptions", "r1")?.endedAt).toBeTruthy();
    expect(a.tags()).toContain("refund");
    expect((await u.get("/api/billing/refund")).body).toMatchObject({
      eligible: false,
    });
  });

  it("outside the window: refused", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("r2", "pro", "annual");
    await a.advanceDays(15);
    expect((await u.get("/api/billing/refund")).body).toMatchObject({
      eligible: false,
      reason: "outside_window",
    });
    const r = await u.post("/api/billing/refund");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("refund_outside_window");
  });

  it("once per email ever: a new account with the same email — or a gmail variant — gets no second first-payment refund", async () => {
    a = await billingApp();
    await a.subscribe(
      "r3",
      "pro",
      "monthly",
      "success",
      undefined,
      "John.Doe@gmail.com",
    );
    expect((await a.as("r3").post("/api/billing/refund")).status).toBe(200);
    await a.subscribe(
      "r3b",
      "pro",
      "monthly",
      "success",
      undefined,
      "John.Doe@gmail.com",
    );
    expect((await a.as("r3b").get("/api/billing/refund")).body).toMatchObject({
      eligible: false,
      reason: "already_used",
    });
    await a.subscribe(
      "r3c",
      "starter",
      "monthly",
      "success",
      undefined,
      "johndoe+promo@googlemail.com",
    );
    const r = await a.as("r3c").post("/api/billing/refund");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("refund_already_used");
  });

  it("an annual renewal charge is refundable within the window", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("r4", "starter", "annual");
    await a.advanceDays(366); // renews
    const e = (await u.get("/api/billing/refund")).body;
    expect(e).toMatchObject({
      eligible: true,
      kind: "annual_renewal",
      amount: 37440,
    });
    expect((await u.post("/api/billing/refund")).body.kind).toBe(
      "annual_renewal",
    );
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("free");
  });

  it("a monthly renewal charge is not refundable", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("r5", "pro", "monthly");
    await a.advanceDays(31); // renews
    expect((await u.get("/api/billing/refund")).body).toMatchObject({
      eligible: false,
      reason: "monthly_renewal",
    });
    expect((await u.post("/api/billing/refund")).body.code).toBe(
      "refund_monthly_renewal",
    );
  });

  it("admin refund action follows the same policy and is audited", async () => {
    a = await billingApp();
    await a.subscribe("r6", "elite", "monthly");
    expect(
      (await a.admin.get("/api/admin/billing/subscribers/r6/refund")).body
        .eligible,
    ).toBe(true);
    expect(
      (await a.admin.post("/api/admin/billing/subscribers/r6/refund")).body
        .refunded,
    ).toBe(true);
    const audit = (await a.admin.get("/api/admin/billing/audit")).body.audit;
    expect(audit[0]).toMatchObject({
      path: "/api/admin/billing/subscribers/r6/refund",
      outcome: "ok",
    });
  });
});

describe("refunds off (REFUND_WINDOW_DAYS = 0)", () => {
  it("the user and admin endpoints return 404", async () => {
    a = await billingApp({ refundWindowDays: 0 });
    const { u } = await a.subscribe("r7", "pro", "monthly");
    expect((await u.get("/api/billing/refund")).status).toBe(404);
    expect((await u.post("/api/billing/refund")).status).toBe(404);
    expect(
      (await a.admin.post("/api/admin/billing/subscribers/r7/refund")).status,
    ).toBe(404);
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("pro");
  });
});
