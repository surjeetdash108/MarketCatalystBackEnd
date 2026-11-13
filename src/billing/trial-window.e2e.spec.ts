import { billingApp } from "../../test/support/billing-app";
import { DAY, T0 } from "../../test/support/billing-harness";
import { trialTerms } from "./provider/stripe/stripe-billing.provider";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});
const OR = { country: "US", state: "OR", postalCode: "97201" };
const iso = (ms: number) => new Date(ms).toISOString();

/** A user whose account was created `ageMs` before now. */
function aged(app: App, uid: string, ageMs: number) {
  const u = app.user(uid, `${uid}@example.com`);
  app.auth.users.get(uid)!.metadata = { creationTime: new Date(T0 - ageMs).toUTCString() };
  return u;
}
const preview = (u: ReturnType<App["user"]>) =>
  u.post("/api/billing/checkout/preview", { planId: "pro", interval: "monthly", region: OR });

describe("free trial: 7 days in total, counted from account creation", () => {
  it("signed up 4 days ago: the trial ends 3 days from now and the subscription starts billing then", async () => {
    a = await billingApp({ env: { TRIAL_DAYS: "7", TRIAL_WINDOW_FLOOR: "2000-01-01T00:00:00Z" } });
    const u = aged(a, "t4", 4 * DAY);
    const p = (await preview(u)).body;
    expect(p.trial).toEqual({ days: 3, endsAt: iso(T0 + 3 * DAY) });
    expect(p.dueToday).toBe(0);
    expect(p.firstCharge.at).toBe(iso(T0 + 3 * DAY));
    const { complete } = await a.subscribe("t4", "pro", "monthly");
    expect(complete?.status).toBe(200);
    const me = (await u.get("/api/me/entitlements")).body;
    expect(me).toMatchObject({ planId: "pro", status: "TRIALING" });
    expect(a.fs.read("subscriptions", "t4")).toMatchObject({ currentPeriodEnd: iso(T0 + 3 * DAY) });
  });

  it("signed up 8 days ago: no trial, charged today", async () => {
    a = await billingApp({ env: { TRIAL_DAYS: "7", TRIAL_WINDOW_FLOOR: "2000-01-01T00:00:00Z" } });
    const p = (await preview(aged(a, "t8", 8 * DAY))).body;
    expect(p.trial).toBeNull();
    expect(p.dueToday).toBe(p.total);
    expect(p.consent.text).not.toContain("after the trial");
  });

  it("less than an hour left: no trial", async () => {
    a = await billingApp({ env: { TRIAL_DAYS: "7", TRIAL_WINDOW_FLOOR: "2000-01-01T00:00:00Z" } });
    const p = (await preview(aged(a, "t7", 7 * DAY - 30 * 60_000))).body;
    expect(p.trial).toBeNull();
  });

  it("accounts made before the rule shipped count their 7 days from the rollout", async () => {
    a = await billingApp({ env: { TRIAL_DAYS: "7", TRIAL_WINDOW_FLOOR: iso(T0 - DAY) } });
    const p = (await preview(aged(a, "old", 90 * DAY))).body;
    expect(p.trial).toEqual({ days: 6, endsAt: iso(T0 + 6 * DAY) });
  });
});

describe("trialTerms (Stripe params)", () => {
  const now = 1_000_000;
  it("an exact end wins while it's in the future", () => {
    expect(trialTerms(7, now + 3600, now)).toEqual({ trial_end: now + 3600 });
  });
  it("an end that has passed means no trial (charge now)", () => {
    expect(trialTerms(7, now - 10, now)).toEqual({});
  });
  it("no exact end falls back to days", () => {
    expect(trialTerms(7, null, now)).toEqual({ trial_period_days: 7 });
    expect(trialTerms(0, null, now)).toEqual({});
  });
});
