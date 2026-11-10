import { REFUND_WINDOW_DAYS } from "./refund-policy.config";

/**
 * Rules (derived from REFUND_WINDOW_DAYS only):
 *  - a subscription's FIRST payment: full refund within the window, once per
 *    normalised email ever;
 *  - an ANNUAL renewal charge: full refund within the window;
 *  - a MONTHLY renewal charge: never refundable;
 *  - a refund ends the subscription immediately (the account has no plan until it subscribes again).
 */
export interface RefundPolicy {
  enabled: boolean;
  windowDays: number;
  /** One line for the checkout "How your subscription works" box. */
  checkoutLine: string;
  /** The refund paragraph of Terms §12 (UI and Website). */
  termsParagraph: string;
  /** The Manage Plan explanation under the "Request refund" button. */
  managePlanLine: string;
}

export function refundPolicy(
  windowDays: number = REFUND_WINDOW_DAYS,
): RefundPolicy {
  const days = Number.isInteger(windowDays) && windowDays > 0 ? windowDays : 0;
  if (days === 0) {
    const off = "No refunds for partial billing periods.";
    return {
      enabled: false,
      windowDays: 0,
      checkoutLine: off,
      termsParagraph:
        "No refunds for partial billing periods. We do not provide refunds or credits for unused time, except where the law requires it.",
      managePlanLine: off,
    };
  }
  const d = `${days} day${days === 1 ? "" : "s"}`;
  return {
    enabled: true,
    windowDays: days,
    checkoutLine: `Full refund within ${d} of your first payment (once per person) or of an annual renewal. Monthly renewals aren't refundable.`,
    termsParagraph:
      `You can ask for a full refund within ${d} of your first subscription payment; this is available once per person (per email address). ` +
      `Annual renewal charges can also be refunded in full within ${d} of the renewal. Monthly renewal charges are not refundable. ` +
      `A refund ends your subscription immediately; to keep using MarketCatalyst you choose a plan again. ` +
      `Otherwise we do not refund partial billing periods, except where the law requires it. When you move to a lower plan, the unused part of your current plan is credited to your account and used automatically on your next invoices; credits are not paid out to your card.`,
    managePlanLine: `Within ${d} of your first payment, or of an annual renewal, you can get a full refund. Your plan ends right away.`,
  };
}

const DAY_MS = 86_400_000;

/** Is a charge made at `paidAtMs` still inside the window at `nowMs`? */
export function insideWindow(
  paidAtMs: number,
  nowMs: number,
  windowDays: number = REFUND_WINDOW_DAYS,
): boolean {
  const p = refundPolicy(windowDays);
  return p.enabled && nowMs - paidAtMs <= p.windowDays * DAY_MS;
}
