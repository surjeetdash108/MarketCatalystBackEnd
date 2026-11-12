import { planById, type BillingInterval } from "../../plans/plans.registry";

/**
 * The renewal consent the buyer ticks at checkout. Bump CONSENT_VERSION
 * whenever the wording changes; the stored record keeps the version and the
 * exact text that was shown.
 */
export const CONSENT_VERSION = "2026-11-12.1";

/** The exact text shown and recorded; mentions the free trial when there is one. */
export function consentText(
  planId: string,
  interval: BillingInterval,
  trialDays = 0,
): string {
  const plan = planById(planId)?.name ?? planId;
  const cadence = interval === "annual" ? "annually" : "monthly";
  const start =
    trialDays > 0
      ? `I agree that after my ${trialDays}-day free trial my ${plan} plan is charged at the price shown and renews ${cadence} until I cancel. If I cancel before the trial ends I pay nothing.`
      : `I agree that my ${plan} plan renews ${cadence} at the price shown until I cancel.`;
  return `${start} I agree to the Terms of Use and have read the Privacy Policy.`;
}
