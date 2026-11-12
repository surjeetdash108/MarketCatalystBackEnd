import { billingApp } from "../../test/support/billing-app";
import { T0 } from "../../test/support/billing-harness";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});

describe("admin: people who tried to sign up but didn't finish", () => {
  it("lists payment-page drop-offs (plan, attempts, first/last time) and accounts that never chose a plan; excludes subscribers and staff", async () => {
    a = await billingApp();
    const created = new Date(T0).toISOString();
    // reached the payment page twice, never paid
    const drop = a.user("drop", "drop@example.com");
    a.fs.seed("users", "drop", { email: "drop@example.com", name: "Dee Drop", createdAt: created });
    await drop.post("/api/billing/checkout/preview", { planId: "pro", interval: "annual" });
    await drop.post("/api/billing/checkout/preview", { planId: "elite", interval: "monthly" });
    // signed up, never went to checkout
    a.user("idle", "idle@example.com");
    a.fs.seed("users", "idle", { email: "idle@example.com", name: "Ida Idle", createdAt: created });
    // went to checkout and paid → not listed
    a.fs.seed("users", "paid", { email: "paid@example.com", createdAt: created });
    const { u: paid } = await a.subscribe("paid", "starter", "monthly");
    await paid.post("/api/billing/checkout/preview", { planId: "pro", interval: "monthly" });
    // staff → not listed
    await a.admin.post("/api/admin/staff-access", { email: "ops@example.com" });
    a.fs.seed("users", "ops", { email: "ops@example.com", createdAt: created });

    const r = (await a.admin.get("/api/admin/billing/abandoned")).body;
    expect(r.checkoutAbandoned).toEqual([
      expect.objectContaining({ uid: "drop", email: "drop@example.com", name: "Dee Drop", planId: "elite", interval: "monthly", attempts: 2, step: "Payment page", signedUpAt: created }),
    ]);
    expect(r.checkoutAbandoned[0].firstAttemptAt <= r.checkoutAbandoned[0].lastAttemptAt).toBe(true);
    expect(r.signedUpNoPlan.map((x: { uid: string }) => x.uid)).toEqual(["idle"]);
    expect(r.signedUpNoPlan[0]).toMatchObject({ email: "idle@example.com", signedUpAt: created });
    expect((await a.user("u9").get("/api/admin/billing/abandoned")).status).toBe(403);
  });
});
