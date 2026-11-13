import { billingApp, checkoutBody } from "../../../test/support/billing-app";
import { CONSENT_VERSION, consentText } from "./consent";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});
const TX = {
  name: "Tex Buyer",
  address: {
    line1: "500 Congress Ave",
    line2: "Suite 2",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
  },
};

describe("checkout preview (step 2 summary)", () => {
  it("tax comes from the provider for the billing region (fake: SIMULATED Texas rate)", async () => {
    a = await billingApp();
    const u = a.user("p1");
    const tx = (
      await u.post("/api/billing/checkout/preview", {
        planId: "pro",
        interval: "monthly",
        region: { country: "US", state: "TX", postalCode: "78701" },
      })
    ).body;
    expect(tx).toMatchObject({
      subtotal: 5900,
      discount: 0,
      tax: 487,
      total: 6387,
      taxPending: false,
    });
    expect(tx.taxLabel).toMatch(/TX.*simulated/);
    const or = (
      await u.post("/api/billing/checkout/preview", {
        planId: "pro",
        interval: "monthly",
        region: { country: "US", state: "OR", postalCode: "97201" },
      })
    ).body;
    expect(or).toMatchObject({ tax: 0, total: 5900, taxLabel: null });
    const none = (
      await u.post("/api/billing/checkout/preview", {
        planId: "pro",
        interval: "monthly",
      })
    ).body;
    expect(none).toMatchObject({ tax: 0, taxPending: true });
  });

  it("returns the renewal date/price, consent text+version and the no-refunds policy", async () => {
    a = await billingApp();
    const p = (
      await a.user("p2").post("/api/billing/checkout/preview", {
        planId: "elite",
        interval: "annual",
      })
    ).body;
    expect(p.renewalAmount).toBe(179100);
    expect(p.renewsAt).toBe("2027-11-10T12:00:00.000Z");
    expect(p.consent).toEqual({
      version: CONSENT_VERSION,
      text: consentText("elite", "annual"),
    });
    expect(p.consent.text).toBe(
      "I understand my Elite plan renews at $1791/year until I cancel. I agree to the Terms of Use and Privacy Policy.",
    );
    expect(p.refundPolicy).toMatchObject({ enabled: false, windowDays: 0, checkoutLine: expect.stringMatching(/^No refunds\./) });
  });

  it("promo: a valid code discounts before tax; an invalid one is a generic 400 that counts as an attempt", async () => {
    a = await billingApp();
    await a.admin.post("/api/admin/billing/promos", {
      code: "SAVE10",
      percentOff: 10,
      duration: "once",
    });
    const u = a.user("p3");
    const ok = (
      await u.post("/api/billing/checkout/preview", {
        planId: "pro",
        interval: "monthly",
        promoCode: "save10",
        region: { country: "US", state: "TX", postalCode: "78701" },
      })
    ).body;
    expect(ok).toMatchObject({
      subtotal: 5900,
      discount: 590,
      tax: 438,
      total: 5748,
      promo: { code: "SAVE10" },
    });
    const bad = await u.post("/api/billing/checkout/preview", {
      planId: "pro",
      interval: "monthly",
      promoCode: "NOPE",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("promo_invalid");
    expect(a.fs.read("promo_attempts", "uid:p3")?.count).toBe(1);
  });
});

describe("checkout (step 2 'Complete purchase')", () => {
  it("email/password accounts must verify their email first", async () => {
    a = await billingApp();
    const u = a.user("c1", "c1@example.com", { emailVerified: false });
    const r = await u.post(
      "/api/billing/checkout",
      checkoutBody("pro", "monthly"),
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("email_unverified");
  });

  it("the renewal consent is required (ticked, current version)", async () => {
    a = await billingApp();
    const u = a.user("c2");
    expect(
      (
        await u.post(
          "/api/billing/checkout",
          checkoutBody("pro", "monthly", {
            consent: { accepted: false, version: CONSENT_VERSION },
          }),
        )
      ).body.code,
    ).toBe("consent_required");
    expect(
      (
        await u.post(
          "/api/billing/checkout",
          checkoutBody("pro", "monthly", {
            consent: { accepted: true, version: "old" },
          }),
        )
      ).body.code,
    ).toBe("consent_required");
    expect(
      (
        await u.post(
          "/api/billing/checkout",
          checkoutBody("pro", "monthly", { consent: undefined }),
        )
      ).status,
    ).toBe(400);
  });

  it("mobile number is not collected or stored at checkout", async () => {
    a = await billingApp();
    const u = a.user("c3");
    const res = await u.post("/api/billing/checkout", checkoutBody("pro", "monthly"));
    expect(res.status).toBe(200);
    expect(a.fs.read("customers", "c3")?.phone ?? null).toBeNull();
  });

  it("a US billing address needs state and ZIP", async () => {
    a = await billingApp();
    const u = a.user("c4");
    const r = await u.post(
      "/api/billing/checkout",
      checkoutBody("pro", "monthly", {
        billing: {
          name: "X",
          address: { line1: "1 A St", city: "Austin", country: "US" },
        },
      }),
    );
    expect(r.body.code).toBe("address_invalid");
  });

  it("stores consent with the subscription and only country/state/ZIP of the address", async () => {
    a = await billingApp();
    const u = a.user("c5");
    a.clock.freeze(a.clock.now());
    const co = await u.post(
      "/api/billing/checkout",
      checkoutBody("pro", "annual", {
        billing: TX,
        marketingOptIn: true,
      }),
    );
    expect(co.status).toBe(200);
    expect(co.body).toMatchObject({
      tax: 4673,
      amountDueToday: 56640 + 4673,
      payment: { provider: "fake" },
    });
    await u.post(`/api/billing/fake/checkout/${co.body.sessionId}/complete`, {
      card: "success",
    });
    const mirror = a.fs.read("subscriptions", "c5");
    expect(mirror?.consent).toMatchObject({
      version: CONSENT_VERSION,
      text: consentText("pro", "annual"),
      planId: "pro",
      interval: "annual",
      price: 56640,
      currency: "USD",
    });
    expect(typeof (mirror?.consent as { acceptedAt: string }).acceptedAt).toBe(
      "string",
    );
    expect("ip" in (mirror?.consent as object)).toBe(true);
    const cust = a.fs.read("customers", "c5");
    expect(cust).toMatchObject({
      billingRegion: { country: "US", state: "TX", postalCode: "78701" },
      marketingOptIn: { optedIn: true },
    });
    expect(JSON.stringify(cust)).not.toContain("Congress");
    expect(
      JSON.stringify(a.fs.read("checkout_sessions", co.body.sessionId)),
    ).not.toContain("Congress");
    // The full address went to the provider only.
    const fakeCustomer = await a.provider.getCustomer(String(cust?.customerId));
    expect(fakeCustomer?.billing?.address.line1).toBe("500 Congress Ave");
  });

  it("a declined card leaves the buyer on the page with a clear code; 3-D Secure must be approved", async () => {
    a = await billingApp();
    const u = a.user("c6");
    const co = await u.post(
      "/api/billing/checkout",
      checkoutBody("pro", "monthly"),
    );
    const declined = await u.post(
      `/api/billing/fake/checkout/${co.body.sessionId}/complete`,
      { card: "decline" },
    );
    expect(declined.body).toEqual({ status: "failed", code: "card_declined" });
    expect(a.fs.read("subscriptions", "c6")).toBeUndefined();
    const sca = await u.post(
      `/api/billing/fake/checkout/${co.body.sessionId}/complete`,
      { card: "requires_3ds" },
    );
    expect(sca.body.status).toBe("requires_action");
    const ok = await u.post(`/api/billing/fake/actions/${sca.body.actionId}`, {
      approve: true,
    });
    expect(ok.status).toBe(200);
    expect(
      (await u.get(`/api/billing/checkout/${co.body.sessionId}`)).body.active,
    ).toBe(true);
  });
});
