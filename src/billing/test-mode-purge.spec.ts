import { FakeFirestore } from "../../test/support/fake-firestore";
import type { Firestore } from "firebase-admin/firestore";
import { purgeTestModeBilling } from "./test-mode-purge";
import { RestFirestore } from "../../scripts/lib/script-firestore";

function seeded() {
  const fs = new FakeFirestore();
  fs.seed("subscriptions", "staff1", { planId: "pro", livemode: false });
  fs.seed("subscriptions", "cust1", { planId: "pro", livemode: true });
  fs.seed("subscriptions", "old1", { planId: "starter" }); // predates the field = live
  fs.seed("payments", "in_test", { userId: "staff1", livemode: false });
  fs.seed("payments", "in_live", { userId: "cust1", livemode: true });
  fs.seed("customers", "staff1", { customerId: "cus_t", livemode: false });
  fs.seed("subscription_events", "e1", { uid: "staff1", livemode: false });
  fs.seed("stripe_events", "evt_t", { livemode: false });
  fs.seed("checkout_sessions", "sub_t", { uid: "staff1", livemode: false });
  fs.seed("promo_redemptions", "sub_t", { uid: "staff1", livemode: false });
  fs.seed("users", "staff1", {
    email: "s@example.com",
    name: "Staff",
    currentPlan: "pro",
    subscriptionStatus: "ACTIVE",
  });
  fs.seed("users", "cust1", { currentPlan: "pro" });
  return fs;
}

describe("purgeTestModeBilling", () => {
  it("dry run (default use) lists test-mode records and writes nothing", async () => {
    const fs = seeded();
    const r = await purgeTestModeBilling(fs as unknown as Firestore, {
      dryRun: true,
    });
    expect(r.deleted).toMatchObject({
      subscriptions: ["staff1"],
      payments: ["in_test"],
      customers: ["staff1"],
      subscription_events: ["e1"],
      stripe_events: ["evt_t"],
      checkout_sessions: ["sub_t"],
      promo_redemptions: ["sub_t"],
    });
    expect(r.usersReset).toEqual(["staff1"]);
    expect(fs.read("subscriptions", "staff1")).toBeDefined();
    expect(fs.read("users", "staff1")?.currentPlan).toBe("pro");
  });

  it("apply deletes only livemode:false records and resets just the projection fields", async () => {
    const fs = seeded();
    await purgeTestModeBilling(fs as unknown as Firestore, { dryRun: false });
    expect(fs.ids("subscriptions").sort()).toEqual(["cust1", "old1"]);
    expect(fs.ids("payments")).toEqual(["in_live"]);
    expect(fs.ids("customers")).toEqual([]);
    expect(fs.ids("checkout_sessions")).toEqual([]);
    expect(fs.read("users", "staff1")).toMatchObject({
      email: "s@example.com",
      name: "Staff",
      currentPlan: "none",
      subscriptionStatus: null,
    });
    expect(fs.read("users", "cust1")?.currentPlan).toBe("pro");
  });
});

describe("RestFirestore batch delete", () => {
  it("sends a delete write in the commit", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const db = new RestFirestore("p", "mc", "tok", (url, init) => {
      calls.push({ url, body: init?.body });
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      });
    });
    const b = db.batch();
    b.delete(db.doc("payments/in_test"));
    await b.commit();
    expect(calls[0].url).toMatch(/documents:commit$/);
    expect(JSON.parse(calls[0].body)).toEqual({
      writes: [
        { delete: "projects/p/databases/mc/documents/payments/in_test" },
      ],
    });
  });
});
