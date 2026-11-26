import { refundPolicy } from "./refund-policy";

/**
 * The subscription terms, written once (26 Nov 2026 audit, W-26).
 *
 * Home's pricing line, checkout and Terms §12 (app and website) all print
 * these sentences, generated from TRIAL_DAYS and refundPolicy() by
 * scripts/export-catalog.ts, so the binding Terms can never say something
 * the pricing page does not (on Nov 26 Home sold a 7-day trial, renewal and
 * "No refunds" while §12 said "launching soon").
 *
 * Owner's decision (25 Nov 2026): every new account gets a free trial of
 * TRIAL_DAYS from sign-up, whether or not it buys a plan; a plan bought
 * during the trial starts when the trial ends, one bought after starts at
 * once; without a plan, access ends with the trial. No refunds.
 */
export interface SubscriptionTerms {
  /** "Every new account gets a 7-day free trial from sign-up; …" ("" with no trial). */
  trialLine: string;
  renewalLine: string;
  /** The line under Home's plan toggle: trial + renewal + refund. */
  purchaseLine: string;
  /** Terms §12, one string per paragraph. */
  termsParagraphs: string[];
}

export function subscriptionTerms(trialDays: number): SubscriptionTerms {
  const refund = refundPolicy();
  const trialLine =
    trialDays > 0
      ? `Every new account gets a ${trialDays}-day free trial from sign-up; a plan you buy during it starts when the trial ends.`
      : "";
  const renewalLine = "Plans renew automatically until you cancel.";
  const termsParagraphs = [
    "Paid plans (Starter, Pro and Elite) are billed monthly or annually, in advance, at the price shown on the pricing page and at checkout, plus any applicable tax. Payments are processed by our payment provider, Stripe.",
    ...(trialDays > 0
      ? [
          `Free trial. Every new account gets a ${trialDays}-day free trial, counted from sign-up, whether or not you buy a plan. If you buy a plan during the trial, it starts, and you are first charged, when the trial ends. If you buy a plan after the trial, it starts, and you are charged, immediately. If you do not buy a plan, your access to the Service ends when the trial ends.`,
        ]
      : []),
    "Auto-renewal. Your plan renews automatically at the end of each billing period, for the same period, and the payment method on file is charged the plan's price at that time, until you cancel. Checkout shows the amount and date of your first charge and of each renewal before you confirm.",
    `Cancellation and refunds. ${refund.termsParagraph}`,
  ];
  return {
    trialLine,
    renewalLine,
    purchaseLine: [trialLine, renewalLine, refund.checkoutLine]
      .filter(Boolean)
      .join(" "),
    termsParagraphs,
  };
}
