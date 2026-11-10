import { readFileSync } from "fs";
import { join } from "path";
import { billingHarness, priceRef } from "../../test/support/billing-harness";
import {
  PLAN_DEFINITIONS,
  catalogPrice,
  isPaidPlanId,
} from "../plans/plans.registry";
import { stripeSeedPlan } from "./provider/stripe/stripe-seed-plan";

/**
 * One catalog: the website's price list, GET /plans, the fake provider's
 * charges and the Stripe seed (Products/Prices to create) must all agree.
 * Change one price anywhere but the registry and this fails.
 */
const website = JSON.parse(
  readFileSync(
    join(__dirname, "../../../MarketCatalystWebsite/lib/pricing/catalog.json"),
    "utf8",
  ),
) as {
  plans: Array<{
    id: string;
    prices: Record<string, { amount: number; lookupKey: string }>;
  }>;
};

describe("catalog contract: website = GET /plans = provider = Stripe seed", () => {
  const paid = PLAN_DEFINITIONS.filter((p) => isPaidPlanId(p.id));
  const rows = paid.flatMap((p) =>
    (["monthly", "annual"] as const).map((i) => [p.id, i] as const),
  );

  it.each(rows)("%s %s agrees everywhere", async (planId, interval) => {
    const registry = catalogPrice(planId, interval);
    const web = website.plans.find((p) => p.id === planId).prices[interval];
    expect(web).toEqual({
      amount: registry.amount,
      lookupKey: registry.lookupKey,
    });

    const h = billingHarness();
    const getPlans = await h.plans.listActive();
    expect(getPlans.find((p) => p.id === planId).prices[interval]).toEqual(
      registry,
    );

    const { done } = await h.buy("u1", planId, interval);
    const sub = await h.provider.getSubscription(done.subscriptionId);
    expect(sub).toMatchObject({
      amount: registry.amount,
      priceLookupKey: registry.lookupKey,
    });
    expect(priceRef(planId, interval).amount).toBe(registry.amount);

    const seed = stripeSeedPlan().prices.find(
      (p) => p.lookupKey === registry.lookupKey,
    );
    expect(seed).toMatchObject({
      planId,
      unitAmount: registry.amount,
      interval: interval === "monthly" ? "month" : "year",
    });
  });

  it("the Stripe seed creates exactly the paid plans and six prices, plus the retention coupon and a card-only portal", () => {
    const plan = stripeSeedPlan();
    expect(plan.products.map((p) => p.planId)).toEqual([
      "starter",
      "pro",
      "elite",
    ]);
    expect(plan.prices).toHaveLength(6);
    expect(plan.retentionCoupon).toMatchObject({
      percentOff: 50,
      duration: "repeating",
      durationInMonths: 2,
    });
    expect(plan.portal.features).toEqual([
      "payment_method_update",
      "invoice_history",
    ]);
  });

  it("the website lists the same plans as GET /plans", async () => {
    const h = billingHarness();
    expect(website.plans.map((p) => p.id)).toEqual(
      (await h.plans.listActive()).map((p) => p.id),
    );
  });
});
