import { billingApp } from "../../test/support/billing-app";
import { DAY, T0 } from "../../test/support/billing-harness";
import { trialTerms } from "./provider/stripe/stripe-billing.provider";
import { etCalendarDaysEnd } from "../common/et-calendar";

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

describe("free trial: ends at 11:59 PM US Eastern on the 7th calendar day after sign-up", () => {
  it("signed up 4 days ago: the trial ends 3 calendar days from now at 11:59 PM ET and billing starts then", async () => {
    a = await billingApp({ env: { TRIAL_DAYS: "7", TRIAL_WINDOW_FLOOR: "2000-01-01T00:00:00Z" } });
    const u = aged(a, "t4", 4 * DAY);
    const end = etCalendarDaysEnd(T0 - 4 * DAY, 7);
    const p = (await preview(u)).body;
    expect(p.trial).toEqual({ days: 3, endsAt: iso(end) });
    expect(p.dueToday).toBe(0);
    expect(p.firstCharge.at).toBe(iso(end));
    const { complete } = await a.subscribe("t4", "pro", "monthly");
    expect(complete?.status).toBe(200);
    const me = (await u.get("/api/me/entitlements")).body;
    expect(me).toMatchObject({ planId: "pro", status: "TRIALING" });
    expect(a.fs.read("subscriptions", "t4")).toMatchObject({ currentPeriodEnd: iso(end) });
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
    const u = aged(a, "t7", 7 * DAY);
    // 30 minutes before the trial's 11:59 PM ET end on the 7th day.
    a.clock.freeze(etCalendarDaysEnd(T0 - 7 * DAY, 7) - 30 * 60_000);
    const p = (await preview(u)).body;
    expect(p.trial).toBeNull();
  });

  it("signed up Nov 13 at 11:50 PM ET: the trial ends Nov 20 at 11:59 PM ET (calendar days, not 7 × 24 h)", () => {
    const signup = Date.parse("2026-11-14T04:50:00Z"); // Nov 13, 11:50 PM EST
    expect(new Date(etCalendarDaysEnd(signup, 7)).toISOString()).toBe("2026-11-21T04:59:59.000Z"); // Nov 20, 11:59:59 PM EST
    const summer = Date.parse("2026-07-01T03:30:00Z"); // Jun 30, 11:30 PM EDT
    expect(new Date(etCalendarDaysEnd(summer, 7)).toISOString()).toBe("2026-07-08T03:59:59.000Z"); // Jul 7, 11:59:59 PM EDT
  });

  it("accounts made before the rule shipped count their 7 days from the rollout", async () => {
    a = await billingApp({ env: { TRIAL_DAYS: "7", TRIAL_WINDOW_FLOOR: iso(T0 - DAY) } });
    const p = (await preview(aged(a, "old", 90 * DAY))).body;
    expect(p.trial).toEqual({ days: 6, endsAt: iso(etCalendarDaysEnd(T0 - DAY, 7)) });
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
