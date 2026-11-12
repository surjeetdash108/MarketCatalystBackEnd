import { billingApp } from "../../../test/support/billing-app";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});

describe("contact after checkout", () => {
  it("the user can view and edit marketing preferences; phone is not collected", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("m1", "pro", "monthly");
    expect((await u.get("/api/billing/contact")).body).toMatchObject({
      phone: null,
      marketingOptIn: { optedIn: false },
    });
    const r = await u.post("/api/billing/contact", {
      marketingOptIn: true,
    });
    expect(r.body).toMatchObject({
      phone: null,
      marketingOptIn: { optedIn: true },
    });
    expect(typeof r.body.marketingOptIn.at).toBe("string");
  });

  it("admin detail shows consent; no phone is stored", async () => {
    a = await billingApp();
    a.fs.seed("users", "m2", { name: "M", email: "m2@example.com" });
    await a.subscribe("m2", "elite", "annual");
    const d = (await a.admin.get("/api/admin/billing/subscribers/m2")).body;
    expect(d.phoneMasked).toBeNull();
    expect(d.consent).toMatchObject({
      planId: "elite",
      interval: "annual",
      price: 179100,
    });
    const reveal = await a.admin.post(
      "/api/admin/billing/subscribers/m2/phone/reveal",
    );
    expect(reveal.body).toEqual({ phone: null });
  });
});
