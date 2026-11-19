import { billingApp } from "../../test/support/billing-app";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});

function seedData(app: App, uid: string) {
  app.fs.seed("users", uid, { email: `${uid}@example.com`, name: "X" });
  app.fs.seed(`users/${uid}/watchlists`, "w1", { name: "Tech" });
  app.fs.seed(`users/${uid}/portfolios/default/holdings`, "AAPL", { shares: 1 });
  app.fs.seed("stock_comments", "c1", { uid, text: "note" });
  app.fs.seed("stock_comments", "c2", { uid: "someone_else", text: "keep" });
  app.fs.seed("feature_requests", "f1", { uid, text: "idea" });
  app.fs.seed("user_sessions", uid, { sessionId: "s" });
}

describe("delete account: everything, everywhere", () => {
  it("self-delete needs confirm: DELETE", async () => {
    a = await billingApp();
    const u = a.user("d0", "d0@example.com");
    expect((await u.delete("/api/account").send({ confirm: "yes" })).status).toBe(400);
    expect(a.auth.users.has("d0")).toBe(true);
  });

  it("self-delete cancels the live subscription now and removes data, subcollections and the sign-in", async () => {
    a = await billingApp();
    await a.subscribe("d1", "pro", "monthly");
    seedData(a, "d1");
    const subId = (a.fs.read("subscriptions", "d1") as { subscriptionId: string }).subscriptionId;
    const r = await a.as("d1").delete("/api/account").send({ confirm: "DELETE" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: true, subscriptionsCancelled: 1 });
    expect((await a.provider.getSubscription(subId))?.status).toBe("canceled");
    expect(a.auth.users.has("d1")).toBe(false);
    for (const [col, id] of [["users", "d1"], ["subscriptions", "d1"], ["customers", "d1"], ["user_sessions", "d1"], ["stock_comments", "c1"], ["feature_requests", "f1"]])
      expect(a.fs.read(col, id)).toBeUndefined();
    expect(a.fs.ids("users/d1/watchlists")).toEqual([]);
    expect(a.fs.ids("users/d1/portfolios/default/holdings")).toEqual([]);
    // Other people's data is untouched; the tombstone stops late events re-creating records.
    expect(a.fs.read("stock_comments", "c2")).toBeDefined();
    expect(a.fs.read("deleted_accounts", "d1")).toMatchObject({ by: "self" });
    await a.events.syncSubscription(subId, null);
    expect(a.fs.read("subscriptions", "d1")).toBeUndefined();
  });

  it("admin delete does the same, by uid", async () => {
    a = await billingApp();
    a.user("d2", "d2@example.com");
    seedData(a, "d2");
    const r = await a.admin.delete("/api/admin/users/d2");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ uid: "d2", authDeleted: true, subscriptionsCancelled: 0 });
    expect(a.fs.read("users", "d2")).toBeUndefined();
    expect(a.auth.users.has("d2")).toBe(false);
    // Already gone (e.g. removed in the Firebase console): still cleans up, no error.
    a.fs.seed("users", "d3", { email: "d3@example.com" });
    const again = await a.admin.delete("/api/admin/users/d3");
    expect(again.status).toBe(200);
    expect(a.fs.read("users", "d3")).toBeUndefined();
  });
});
