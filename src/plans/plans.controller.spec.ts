import { billingHarness, configOf } from "../../test/support/billing-harness";
import { BillingAccessService } from "../billing/billing-access.service";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { PlansController } from "./plans.controller";

describe("GET /plans", () => {
  async function plans(env: Record<string, string>, provider = true) {
    const h = billingHarness(env);
    const flags = new FeatureFlagsService(h.firebase, configOf(env));
    const c = new PlansController(h.plans, h.subscriptions, flags, new BillingAccessService(flags, provider ? h.provider : null));
    return c.listPlans();
  }
  it("lists the four active plans with both prices", async () => {
    const r = await plans({ SUBSCRIPTIONS_ENABLED: "true" });
    expect(r.plans.map((p) => [p.id, p.prices.monthly?.amount ?? null, p.prices.annual?.amount ?? null])).toEqual([
      ["free", null, null], ["starter", 3900, 37440], ["pro", 5900, 56640], ["elite", 19900, 179100],
    ]);
  });
  it("reports whether paid plans can be bought (flag on AND provider configured)", async () => {
    expect((await plans({ SUBSCRIPTIONS_ENABLED: "true" })).paidPlansAvailable).toBe(true);
    expect((await plans({ SUBSCRIPTIONS_ENABLED: "false" })).paidPlansAvailable).toBe(false);
    expect((await plans({ SUBSCRIPTIONS_ENABLED: "true" }, false)).paidPlansAvailable).toBe(false);
  });
});
