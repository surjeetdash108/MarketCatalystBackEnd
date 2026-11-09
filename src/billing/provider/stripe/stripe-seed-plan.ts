import { PLAN_DEFINITIONS, isPaidPlanId } from "../../../plans/plans.registry";
import { RETENTION_MONTHS, RETENTION_PERCENT } from "../../retention/retention.service";

/**
 * What scripts/stripe-seed.ts creates in Stripe, derived from the catalog only
 * (no prices are typed here). Tested against the catalog by the contract test.
 */
export interface StripeSeedPlan {
  products: Array<{ planId: string; name: string; description: string; metadata: Record<string, string> }>;
  prices: Array<{ planId: string; lookupKey: string; unitAmount: number; currency: string; interval: "month" | "year" }>;
  retentionCoupon: { idEnv: string; percentOff: number; duration: "repeating"; durationInMonths: number; name: string };
  portal: { features: string[] };
}

export function stripeSeedPlan(): StripeSeedPlan {
  const paid = PLAN_DEFINITIONS.filter((p) => p.active && isPaidPlanId(p.id));
  return {
    products: paid.map((p) => ({ planId: p.id, name: `MarketCatalyst ${p.name}`, description: p.description, metadata: { planId: p.id } })),
    prices: paid.flatMap((p) =>
      (["monthly", "annual"] as const)
        .filter((i) => p.prices[i])
        .map((i) => ({ planId: p.id, lookupKey: p.prices[i].lookupKey, unitAmount: p.prices[i].amount, currency: p.currency.toLowerCase(), interval: i === "monthly" ? ("month" as const) : ("year" as const) })),
    ),
    retentionCoupon: { idEnv: "STRIPE_RETENTION_COUPON_ID", percentOff: RETENTION_PERCENT, duration: "repeating", durationInMonths: RETENTION_MONTHS, name: "Retention: 50% off 2 months" },
    portal: { features: ["payment_method_update", "invoice_history"] },
  };
}
