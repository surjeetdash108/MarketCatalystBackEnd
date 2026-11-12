/**
 * The billing policy copy — the only place it is written. There are no
 * refunds: a customer can cancel at any time and keeps the plan until the end
 * of the period already paid for; it isn't renewed after that. Lower plans and
 * annual → monthly take effect at the end of the current period.
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
      "When you move to a lower plan, or from annual to monthly billing, the change takes effect at the end of your current billing period; until then you keep your current plan. " +
      "When you move to a higher plan, it starts right away and you pay the prorated difference for the rest of the current period.",
    managePlanLine:
      "No refunds. If you cancel, your plan stays active until the end of the period you've paid for, then it isn't renewed.",
  };
}
