import { billingApp } from "../../test/support/billing-app";
import { DAY, T0 } from "../../test/support/billing-harness";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});

describe("plan history timeline", () => {
  it("lists trial, payments, plan changes, credits and cancellation in plain words, newest first, with timestamps", async () => {
    a = await billingApp({ env: { TRIAL_DAYS: "7" } });
    const { u } = await a.subscribe("h1", "elite", "monthly");
    await a.advanceDays(8); // trial ends, first charge
    a.clock.freeze(a.clock.now() + 5 * DAY);
    const p = (await u.post("/api/billing/change/preview", { planId: "pro", interval: "monthly" })).body;
    await u.post("/api/billing/change", { planId: "pro", interval: "monthly", expectedCredit: p.creditToBalance, prorationDate: p.prorationDate });
    await u.post("/api/billing/cancel");
    const { entries } = (await u.get("/api/billing/timeline")).body;
    const titles = entries.map((e: { title: string }) => e.title);
    expect(titles).toEqual(expect.arrayContaining([
      "Started a free trial of Elite (Monthly)",
      "Renewal of Elite (Monthly)",
      "Changed plan: Elite (Monthly) → Pro (Monthly)",
      "Credit to your account (change to Pro (Monthly))",
      "Cancelled the subscription",
    ]));
    for (const e of entries) expect(Number.isFinite(Date.parse(e.at))).toBe(true);
    const ats = entries.map((e: { at: string }) => e.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    const credit = entries.find((e: { kind: string }) => e.kind === "credit");
    expect(credit).toMatchObject({ amount: -p.creditToBalance, detail: "Used automatically on your next invoice(s); not refunded to your card." });
    const charge = entries.find((e: { title: string }) => e.title === "Renewal of Elite (Monthly)");
    expect(charge).toMatchObject({ amount: 19900, kind: "payment" });
    const admin = (await a.admin.get("/api/admin/billing/subscribers/h1")).body;
    expect(admin.timeline.map((e: { title: string }) => e.title)).toEqual(titles);
    void T0;
  });
});
