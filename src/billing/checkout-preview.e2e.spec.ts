import { billingApp, checkoutBody } from "../../test/support/billing-app";
import { CHECKOUT_PREVIEW_FLAG } from "./checkout-preview";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});
const STAFF = "ops-staff@example.com";

/** Subscriptions OFF for everyone (production today) + a verified staff account. */
async function setup(
  opts: { preview: boolean; provider?: boolean; testMode?: boolean } = {
    preview: true,
  },
) {
  a = await billingApp({
    env: { SUBSCRIPTIONS_ENABLED: "false" },
    provider: opts.provider,
    testMode: opts.testMode ?? true,
  });
  expect(
    (await a.admin.post("/api/admin/staff-access", { email: STAFF })).status,
  ).toBe(201);
  if (opts.preview) await a.flags.setOverride(CHECKOUT_PREVIEW_FLAG, true);
  const staff = a.user("s1", STAFF, { emailVerified: true });
  a.auth.setCustomUserClaims("s1", { staff: true });
  const customer = a.user("c1", "c1@example.com", { emailVerified: true });
  return { staff, customer };
}

describe("CHECKOUT_PREVIEW (staff-only checkout while SUBSCRIPTIONS_ENABLED is off)", () => {
  it("is off by default: staff see full access and 'staff' in checkout; everyone else 'launching soon'", async () => {
    const { staff, customer } = await setup({ preview: false });
    expect(await a.flags.isEnabled(CHECKOUT_PREVIEW_FLAG)).toBe(false);
    const me = (await staff.get("/api/me/entitlements")).body;
    expect(me).toMatchObject({
      staff: true,
      paidPlansAvailable: false,
      checkoutPreview: false,
    });
    expect(
      (
        await staff.post(
          "/api/billing/checkout",
          checkoutBody("pro", "monthly"),
        )
      ).body.code,
    ).toBe("staff_access");
    const c = await customer.post(
      "/api/billing/checkout",
      checkoutBody("pro", "monthly"),
    );
    expect(c.status).toBe(503);
    expect(c.body.code).toBe("paid_plans_unavailable");
  });

  it("on: staff entitlements stay full access but the checkout and plan picker open for them", async () => {
    const { staff } = await setup();
    const me = (await staff.get("/api/me/entitlements")).body;
    expect(me).toMatchObject({
      staff: true,
      planId: "staff",
      subscriptionsEnabled: false,
      paidPlansAvailable: true,
      checkoutPreview: true,
      providerConnected: true,
    });
    expect(Object.values(me.entitlements).every(Boolean)).toBe(true);
    const summary = (await staff.get("/api/billing/summary")).body;
    expect(summary).toMatchObject({
      paidPlansAvailable: true,
      checkoutPreview: true,
    });
  });

  it("on: non-staff, unverified staff emails and signed-in customers still get 'launching soon'", async () => {
    const { customer } = await setup();
    const me = (await customer.get("/api/me/entitlements")).body;
    expect(me.paidPlansAvailable).toBe(false);
    expect(me.checkoutPreview).toBeUndefined();
    for (const [path, body] of [
      ["/api/billing/checkout", checkoutBody("pro", "monthly")],
      ["/api/billing/checkout/preview", { planId: "pro", interval: "monthly" }],
      [
        "/api/billing/promo/preview",
        { code: "X", planId: "pro", interval: "monthly" },
      ],
    ] as const) {
      const r = await customer.post(path, body);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("paid_plans_unavailable");
    }
    expect((await customer.get("/api/billing/summary")).body).toMatchObject({
      paidPlansAvailable: false,
      checkoutPreview: false,
    });
    // An allowlisted address that isn't verified is not staff.
    const unverified = a.user("s2", "ops-staff@example.com", {
      emailVerified: false,
    });
    expect(
      (await unverified.get("/api/me/entitlements")).body.paidPlansAvailable,
    ).toBe(false);
  });

  it("on: a staff test purchase completes, is marked livemode:false, and keeps the staff claim and full access", async () => {
    await setup();
    const { checkout, complete } = await a.subscribe(
      "s1",
      "pro",
      "monthly",
      "success",
      undefined,
      STAFF,
    );
    expect(checkout.status).toBe(200);
    expect(complete?.status).toBe(200);
    const sub = a.fs.read("subscriptions", "s1");
    expect(sub).toMatchObject({ planId: "pro", livemode: false });
    expect(
      a.fs.read("checkout_sessions", checkout.body.sessionId),
    ).toMatchObject({ livemode: false });
    expect(a.fs.read("customers", "s1")).toMatchObject({ livemode: false });
    const all = (col: string) => a.fs.ids(col).map((id) => a.fs.read(col, id));
    const payments = all("payments");
    expect(payments.length).toBeGreaterThan(0);
    expect(payments.every((p) => p?.livemode === false)).toBe(true);
    const history = all("subscription_events");
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((e) => e?.livemode === false)).toBe(true);
    // Staff claim kept; the plan claim is merged alongside it.
    expect(a.auth.users.get("s1")?.customClaims).toMatchObject({
      staff: true,
      plan: "pro",
    });
    const me = (await a.as("s1").get("/api/me/entitlements")).body;
    expect(me).toMatchObject({ staff: true, planId: "staff" });
    expect(Object.values(me.entitlements).every(Boolean)).toBe(true);
  });

  it("on, no provider connected: quotes still render (tax pending), purchase is 'provider not connected'", async () => {
    const { staff, customer } = await setup({ preview: true, provider: false });
    expect((await staff.get("/api/me/entitlements")).body).toMatchObject({
      paidPlansAvailable: true,
      checkoutPreview: true,
      providerConnected: false,
    });
    const q = await staff.post("/api/billing/checkout/preview", {
      planId: "pro",
      interval: "annual",
      region: { country: "US", state: "TX", postalCode: "78701" },
    });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({
      planId: "pro",
      interval: "annual",
      tax: 0,
      taxPending: true,
      taxLabel: null,
      providerConnected: false,
    });
    expect(q.body.total).toBe(q.body.subtotal);
    expect(q.body.consent.text).toMatch(/Pro plan renews annually/);
    const co = await staff.post(
      "/api/billing/checkout",
      checkoutBody("pro", "annual"),
    );
    expect(co.status).toBe(503);
    expect(co.body.code).toBe("provider_not_connected");
    expect(a.fs.ids("checkout_sessions")).toHaveLength(0);
    // Everyone else: unchanged.
    expect(
      (
        await customer.post("/api/billing/checkout/preview", {
          planId: "pro",
          interval: "annual",
        })
      ).body.code,
    ).toBe("paid_plans_unavailable");
  });

  it("turning the flag back off closes the preview immediately (no deploy)", async () => {
    const { staff } = await setup();
    expect(
      (await staff.get("/api/me/entitlements")).body.paidPlansAvailable,
    ).toBe(true);
    await a.flags.setOverride(CHECKOUT_PREVIEW_FLAG, false);
    expect(
      (await staff.get("/api/me/entitlements")).body.paidPlansAvailable,
    ).toBe(false);
    expect(
      (
        await staff.post(
          "/api/billing/checkout",
          checkoutBody("pro", "monthly"),
        )
      ).body.code,
    ).toBe("staff_access");
  });
});

describe("test-mode records in admin", () => {
  it("get a Test badge and are excluded from MRR and subscriber counts", async () => {
    a = await billingApp({ testMode: true });
    a.fs.seed("users", "t1", { name: "Tester", email: "t1@example.com" });
    await a.subscribe("t1", "pro", "monthly");
    const body = (await a.admin.get("/api/admin/billing/subscribers")).body;
    const t1 = body.subscribers.find((r: { uid: string }) => r.uid === "t1");
    expect(t1).toMatchObject({ test: true, mrrMinor: 0, planId: "pro" });
    expect(body.totalMrrMinor).toBe(0);
    expect(body.subscriberCount).toBe(0);
    expect(body.testCount).toBe(1);
    const csv = (await a.admin.get("/api/admin/billing/subscribers?format=csv"))
      .text;
    expect(csv.split("\n")[0].endsWith(",staff,legacyPro,test")).toBe(true);
  });

  it("a live-mode customer id is never reused by a test-mode checkout", async () => {
    a = await billingApp({ testMode: true });
    a.fs.seed("customers", "u9", {
      uid: "u9",
      provider: "fake",
      customerId: "cus_live_1",
      livemode: true,
    });
    const { checkout } = await a.subscribe("u9", "pro", "monthly");
    expect(checkout.status).toBe(200);
    expect(
      a.fs.read("checkout_sessions", checkout.body.sessionId)?.customerId,
    ).not.toBe("cus_live_1");
  });
});
