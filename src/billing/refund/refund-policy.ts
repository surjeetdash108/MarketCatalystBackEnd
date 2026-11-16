/**
 * The billing policy copy — the only place it is written. There are no
 * refunds: a customer can cancel at any time and keeps the plan until the end
 * of the period already paid for; it isn't renewed after that. Lower plans and
 * annual → monthly take effect at the end of the current period ("switch");
 * unused value on a switch to a higher plan becomes Market Catalyst credits.
 *
 * Feeds the checkout "How your subscription works" box, Manage Plan and the
 * Terms §12 paragraph (UI and Website — re-run scripts/export-catalog.ts; the
 * catalog contract test fails until you do).
 */
export interface RefundPolicy {
  /** Always false: refunds are not offered. */
  enabled: false;
  windowDays: 0;
  /** One line for the checkout "How your subscription works" box. */
  checkoutLine: string;
  /** The refunds/cancellation paragraph of Terms §12 (UI and Website). */
  termsParagraph: string;
  /** The Manage Plan explanation next to "Cancel plan". */
  managePlanLine: string;
}

export function refundPolicy(): RefundPolicy {
  return {
    enabled: false,
    windowDays: 0,
    checkoutLine:
      "No refunds. Cancel anytime — your plan stays active until the end of the period you've paid for.",
    termsParagraph:
      "Payments are non-refundable, including for partial billing periods and unused time, except where the law requires it. " +
      "You can cancel at any time in Manage Plan: your plan stays active until the end of the billing period you have already paid for and is not renewed after that. " +
      "When you switch to a lower plan (on monthly or annual billing), or from annual to monthly billing on the same plan, your current plan continues until the end of your current billing period and your next charge is for the new plan. " +
      "When you switch to a higher plan (on monthly or annual billing), or from monthly to annual billing on the same plan, the switch happens right away and you pay the prorated difference for the rest of the current period. " +
      "If the unused time on your current plan is worth more than that charge, the difference is kept as Market Catalyst credits. Credits are not refundable and are never applied automatically: you can choose to use them to reduce a future payment, and any remaining credits end when you delete your account.",
    managePlanLine:
      "No refunds. If you cancel, your plan stays active until the end of the period you've paid for, then it isn't renewed.",
  };
}
