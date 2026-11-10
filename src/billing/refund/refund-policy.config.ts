/**
 * THE refund switch — the only place the refund window is set.
 *
 * Days after a charge in which it can be refunded in full; 0 turns refunds off.
 * Everything follows this one line: the checkout bullet, the Manage Plan
 * "Request refund" button, POST /api/billing/refund, the admin refund action,
 * the refund email and the refund paragraph in Terms §12 (UI and Website —
 * re-run scripts/export-catalog.ts; the catalog contract test fails until you do).
 */
export const REFUND_WINDOW_DAYS = 14;
