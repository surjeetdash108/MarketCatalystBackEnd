import { catalogPrice, planById, type BillingInterval } from "../../plans/plans.registry";

/**
 * The renewal consent the buyer ticks at checkout. Bump CONSENT_VERSION
 * whenever the wording changes; the stored record keeps the version and the
 * exact text that was shown.
 */
export const CONSENT_VERSION = "2026-11-14.1";

/** "$199/month" from the plan catalog (no hard-coded prices). */
function priceLabel(planId: string, interval: BillingInterval): string {
  const unit = interval === "annual" ? "year" : "month";
  const p = catalogPrice(planId, interval);
  if (!p) return `the price shown per ${unit}`;
  const dollars = p.amount / 100;
  const amount = Number.isInteger(dollars) ? dollars.toString() : dollars.toFixed(2);
  return `$${amount}/${unit}`;
}

/** The exact text shown and recorded; "after the trial" only when there is one. */
export function consentText(
  planId: string,
  interval: BillingInterval,
  trialDays = 0,
): string {
  const plan = planById(planId)?.name ?? planId;
  const when = trialDays > 0 ? " after the trial" : "";
  return `I understand my ${plan} plan renews at ${priceLabel(planId, interval)}${when} until I cancel. I agree to the Terms of Use and Privacy Policy.`;
}
