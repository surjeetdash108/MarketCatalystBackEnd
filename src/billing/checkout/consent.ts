import { planById, type BillingInterval } from "../../plans/plans.registry";

/**
 * The renewal consent the buyer ticks at checkout. Bump CONSENT_VERSION
 * whenever the wording changes; the stored record keeps the version and the
 * exact text that was shown.
 */
export const CONSENT_VERSION = "2026-11-10.1";

export function consentText(planId: string, interval: BillingInterval): string {
  const plan = planById(planId)?.name ?? planId;
  const cadence = interval === "annual" ? "annually" : "monthly";
  return `I agree that my ${plan} plan renews ${cadence} at the price shown until I cancel. I agree to the Terms of Use and have read the Privacy Policy.`;
}
