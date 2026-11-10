import { billingApp } from "../../../test/support/billing-app";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});

describe("mobile number after checkout", () => {
  it("the user can view and edit it; the new number is sent to the provider", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("m1", "pro", "monthly");
    expect((await u.get("/api/billing/contact")).body).toMatchObject({
      phone: "+15125550147",
      marketingOptIn: { optedIn: false },
    });
    expect(
      (await u.post("/api/billing/contact", { phone: "12" })).body.code,
    ).toBe("phone_invalid");
    const r = await u.post("/api/billing/contact", {
      phone: "+44 7911 123456",
      marketingOptIn: true,
    });
    expect(r.body).toMatchObject({
      phone: "+447911123456",
      marketingOptIn: { optedIn: true },
    });
    expect(typeof r.body.marketingOptIn.at).toBe("string");
    const cust = a.fs.read("customers", "m1");
    expect(
      (await a.provider.getCustomer(String(cust?.customerId)))?.phone,
    ).toBe("+447911123456");
  });

  it("admin detail shows it masked except the last 4 digits, plus the consent; reveal is audited", async () => {
    a = await billingApp();
    a.fs.seed("users", "m2", { name: "M", email: "m2@example.com" });
    await a.subscribe("m2", "elite", "annual");
    const d = (await a.admin.get("/api/admin/billing/subscribers/m2")).body;
    expect(d.phoneMasked).toBe("+1••••••0147");
    expect(JSON.stringify(d)).not.toContain("5125550147");
    expect(d.consent).toMatchObject({
      planId: "elite",
      interval: "annual",
      price: 179100,
    });
    const reveal = await a.admin.post(
      "/api/admin/billing/subscribers/m2/phone/reveal",
    );
    expect(reveal.body).toEqual({ phone: "+15125550147" });
    const audit = (await a.admin.get("/api/admin/billing/audit")).body.audit;
    expect(audit[0]).toMatchObject({
      method: "POST",
      path: "/api/admin/billing/subscribers/m2/phone/reveal",
      outcome: "ok",
      actor: "admin@example.com",
    });
    expect(JSON.stringify(audit)).not.toContain("5125550147");
    expect(
      (await a.user("x").post("/api/admin/billing/subscribers/m2/phone/reveal"))
        .status,
    ).toBe(403);
  });
});
