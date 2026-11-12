import { billingApp } from "../../../test/support/billing-app";
import { REFERRAL_REWARD } from "./referral.service";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});

const preview = (u: ReturnType<App["user"]>, promoCode: string) =>
  u.post("/api/billing/promo/preview", { code: promoCode, planId: "pro", interval: "monthly" });

async function creditOf(app: App, uid: string): Promise<number> {
  const c = app.fs.read("customers", uid) as { customerId?: string } | undefined;
  return c?.customerId ? app.provider.getCreditBalance(c.customerId) : 0;
}

describe("refer a friend: A must have an active plan; A is credited $25 only when B pays", () => {
  it("only a member with an active plan gets a code; the code is random, not derived from the uid", async () => {
    a = await billingApp();
    expect((await a.user("noplan").get("/api/billing/referral")).body).toEqual({ eligible: false, reason: "no_active_plan" });
    await a.subscribe("ref_a", "pro", "monthly");
    const r = (await a.as("ref_a").get("/api/billing/referral")).body;
    expect(r).toMatchObject({ eligible: true, reward: 2500, friendDiscount: 2500, currency: "USD" });
    expect(r.code).toMatch(/^MC-[A-Z2-9]{8}$/);
    expect(r.code).not.toContain("REF_A");
    // Same code every time.
    expect((await a.as("ref_a").get("/api/billing/referral")).body.code).toBe(r.code);
  });

  it("made-up 'MC-…25' codes and the member's own code are rejected; a first-time friend gets $25 off", async () => {
    a = await billingApp();
    await a.subscribe("ref_a", "pro", "monthly");
    const code = (await a.as("ref_a").get("/api/billing/referral")).body.code;
    const b = a.user("friend_b");
    expect((await preview(b, "MC-HELLO25")).status).toBe(400);
    expect((await preview(b, "MC-25")).status).toBe(400);
    expect((await preview(a.as("ref_a"), code)).status).toBe(400);
    const ok = await preview(b, code);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ valid: true });
  });

  it("A is credited once when B pays; a retried event doesn't credit twice", async () => {
    a = await billingApp();
    await a.subscribe("ref_a", "pro", "monthly");
    const code = (await a.as("ref_a").get("/api/billing/referral")).body.code;
    expect(await creditOf(a, "ref_a")).toBe(0);
    const { complete } = await a.subscribe("friend_b", "starter", "monthly", "success", code);
    expect(complete?.status).toBe(200);
    expect(await creditOf(a, "ref_a")).toBe(REFERRAL_REWARD);
    expect(a.fs.read("referral_rewards", "friend_b")).toMatchObject({ referrerUid: "ref_a", status: "credited", amount: 2500 });
    // B's first invoice had the $25 off.
    const inv = (await a.as("friend_b").get("/api/billing/invoices")).body.invoices[0];
    expect(inv).toMatchObject({ amount: 3900 - 2500, discountAmount: 2500 });
    // Re-running the reward (a retried webhook) changes nothing.
    await a.events["referrals"]!.rewardForFirstPayment("friend_b", code);
    expect(await creditOf(a, "ref_a")).toBe(REFERRAL_REWARD);
  });

  it("no credit while B is only on the free trial; the credit comes with B's first real charge", async () => {
    a = await billingApp({ env: { TRIAL_DAYS: "7" } });
    await a.subscribe("ref_a", "pro", "monthly");
    const code = (await a.as("ref_a").get("/api/billing/referral")).body.code;
    const { complete } = await a.subscribe("friend_b", "starter", "monthly", "success", code);
    expect(complete?.status).toBe(200);
    expect(await creditOf(a, "ref_a")).toBe(0);
    expect(a.fs.read("referral_rewards", "friend_b")).toBeUndefined();
    await a.advanceDays(8);
    expect(await creditOf(a, "ref_a")).toBe(REFERRAL_REWARD);
  });
});
