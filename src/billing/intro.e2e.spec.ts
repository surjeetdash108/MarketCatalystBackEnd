import { billingApp } from "../../test/support/billing-app";
import { DAY, T0 } from "../../test/support/billing-harness";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});

describe("new-account intro: 7 days of Market Catalyst, no card, then Choose a plan", () => {
  it("a new account without a plan gets Market Catalyst only, for 7 days, then no plan", async () => {
    a = await billingApp({ env: { SUBSCRIPTIONS_ENABLED: "true", TRIAL_DAYS: "7" } });
    const u = a.user("n1");
    a.fs.seed("users", "n1", { email: "n1@example.com", createdAt: new Date(T0).toISOString() });
    let me = (await u.get("/api/me/entitlements")).body;
    expect(me).toMatchObject({ planId: "intro", status: "INTRO", introEndsAt: new Date(T0 + 7 * DAY).toISOString(), trialDays: 7 });
    expect(me.entitlements.marketCatalyst).toBe(true); // dashboard
    expect(me.entitlements.screener).toBe(true);
    expect(me.entitlements.chartsDaily).toBe(true); // Stock Intelligence
    expect(me.entitlements.moneyFlow).toBe(true); // Money Flow
    expect(me.entitlements.strategyLab).toBe(false); // Strategy Lab (Elite only)
    a.clock.freeze(T0 + 7 * DAY + 1);
    me = (await u.get("/api/me/entitlements")).body;
    expect(me).toMatchObject({ planId: "none", introEndsAt: null });
    expect(me.entitlements.marketCatalyst).toBe(false);
  });

  it("deleting the account and signing up again with the same email doesn't restart the 7 free days", async () => {
    a = await billingApp({ env: { SUBSCRIPTIONS_ENABLED: "true" } });
    const first = a.user("del1", "Pat.Doe+x@gmail.com");
    a.fs.seed("users", "del1", { email: "Pat.Doe+x@gmail.com", createdAt: new Date(T0).toISOString() });
    expect((await first.get("/api/me/entitlements")).body.status).toBe("INTRO");
    // Account deleted; three days later a new account with the same address (a gmail variant).
    await a.fs.collection("users").doc("del1").delete();
    a.auth.users.delete("del1");
    a.clock.freeze(T0 + 3 * DAY);
    const again = a.user("del2", "patdoe@gmail.com");
    a.fs.seed("users", "del2", { email: "patdoe@gmail.com", createdAt: new Date(T0 + 3 * DAY).toISOString() });
    let me = (await again.get("/api/me/entitlements")).body;
    // Still the first account's week: ends on day 7, not day 10.
    expect(me).toMatchObject({ status: "INTRO", introEndsAt: new Date(T0 + 7 * DAY).toISOString() });
    a.clock.freeze(T0 + 7 * DAY + 1);
    me = (await again.get("/api/me/entitlements")).body;
    expect(me).toMatchObject({ planId: "none" });
    // A different person still gets their own week.
    const other = a.user("new3", "someone.else@example.com");
    a.fs.seed("users", "new3", { email: "someone.else@example.com", createdAt: new Date(T0 + 7 * DAY).toISOString() });
    expect((await other.get("/api/me/entitlements")).body.status).toBe("INTRO");
  });

  it("an account older than 7 days, or one that ever subscribed, gets no intro", async () => {
    a = await billingApp({ env: { SUBSCRIPTIONS_ENABLED: "true" } });
    a.user("old");
    a.fs.seed("users", "old", { email: "old@example.com", createdAt: new Date(T0 - 8 * DAY).toISOString() });
    expect((await a.as("old").get("/api/me/entitlements")).body.planId).toBe("none");
    const { u } = await a.subscribe("sub1", "starter", "monthly");
    a.fs.seed("users", "sub1", { email: "sub1@example.com", createdAt: new Date(T0).toISOString() });
    await u.post("/api/billing/cancel");
    a.clock.freeze(T0 + 2 * DAY);
    await a.advanceDays(30);
    expect((await u.get("/api/me/entitlements")).body.planId).toBe("none");
  });
});
