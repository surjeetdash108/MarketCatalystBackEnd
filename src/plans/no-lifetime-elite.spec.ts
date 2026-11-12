import { SubscriptionsService } from "./subscriptions.service";

/**
 * Lifetime Elite was removed on 2026-11-13: those accounts are staff now
 * (config/staff_access). An email alone never grants a plan.
 */
describe("no Lifetime Elite", () => {
  it("a former Lifetime Elite email with no subscription has no plan (access comes from the staff list)", async () => {
    const plans = { get: jest.fn().mockResolvedValue({ name: "No plan" }), entitlementsFor: jest.fn().mockResolvedValue({}) };
    const svc = new SubscriptionsService({} as never, plans as never, { now: () => Date.parse("2026-11-13T00:00:00Z"), nowIso: () => "" } as never);
    const e = await svc.resolve("u1", { email: "andy.microinfo@gmail.com", createdAt: "2026-01-01T00:00:00Z" }, null);
    expect(e).toMatchObject({ planId: "none", entitled: false });
  });
  it("the lifetime list module is gone", () => {
    expect(() => require("./lifetime-elite")).toThrow();
  });
});
