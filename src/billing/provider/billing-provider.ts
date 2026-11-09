import type { BillingDetails, BillingRegion, CheckoutQuote } from "./types";
import type {
  AppliedDiscount,
  ChangePreview,
  ChangeResult,
  CheckoutSession,
  InvoiceDocument,
  PriceRef,
  PromoMirror,
  ProviderEvent,
  ProviderInvoice,
  ProviderName,
  ProviderSubscription,
  RetentionDiscountInput,
} from "./types";

/** DI token for the configured provider (null when none is configured). */
export const BILLING_PROVIDER = Symbol("BILLING_PROVIDER");

/** Thrown by changePlan when the amount differs from the preview the user saw. */
export class PreviewStaleError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Preview is out of date: expected ${expected}, now ${actual}`);
  }
}

/** Thrown when a card is declined during an on-session payment. */
export class PaymentDeclinedError extends Error {
  constructor(readonly code: string) {
    super(`Payment declined: ${code}`);
  }
}

/** Thrown by parseEvent for an unsigned, tampered or unparseable event. */
export class InvalidEventSignatureError extends Error {}

/**
 * Everything the app needs from a payment provider. The app never talks to a
 * provider SDK directly; swapping fake ↔ Stripe is configuration only
 * (BILLING_PROVIDER=fake|stripe).
 *
 * Provider state changes are reported ONLY through events (parseEvent →
 * BillingEventsService); methods return provider objects for display, never
 * for writing app state.
 */
export interface BillingProvider {
  readonly name: ProviderName;

  // ── customers ──────────────────────────────────────────────────────────
  createCustomer(input: {
    uid: string;
    email: string | null;
  }): Promise<{ customerId: string }>;
  setCustomerMetadata(
    customerId: string,
    metadata: Record<string, string>,
  ): Promise<void>;
  /** The customer's phone on the provider's record (no verification). */
  updateCustomerContact(
    customerId: string,
    contact: { phone: string },
  ): Promise<void>;

  // ── checkout ───────────────────────────────────────────────────────────
  /** Price of a new subscription incl. tax for the billing region (Stripe: automatic tax). */
  previewCheckout(input: {
    price: PriceRef;
    discount: AppliedDiscount | null;
    region: BillingRegion | null;
  }): Promise<CheckoutQuote>;
  createCheckout(input: {
    uid: string;
    customerId: string;
    price: PriceRef;
    discount: AppliedDiscount | null;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
    /** Name/address/phone for the provider's customer record and tax. */
    billing?: BillingDetails | null;
  }): Promise<CheckoutSession>;
  getCheckout(sessionId: string): Promise<CheckoutSession | null>;

  // ── subscriptions ──────────────────────────────────────────────────────
  getSubscription(subscriptionId: string): Promise<ProviderSubscription | null>;
  /** Every non-ended subscription, for the nightly reconcile. */
  listSubscriptions(): Promise<ProviderSubscription[]>;
  previewChange(input: {
    subscriptionId: string;
    target: PriceRef;
    kind: "upgrade" | "downgrade";
  }): Promise<ChangePreview>;
  /** Upgrade: immediate, prorated, charged now. Downgrade: scheduled for period end. */
  changePlan(input: {
    subscriptionId: string;
    target: PriceRef;
    kind: "upgrade" | "downgrade";
    prorationDate: number;
    expectedAmountDue: number | null;
  }): Promise<ChangeResult>;
  cancelScheduledChange(subscriptionId: string): Promise<void>;
  cancelAtPeriodEnd(subscriptionId: string): Promise<void>;
  resume(subscriptionId: string): Promise<void>;
  applyRetentionDiscount(
    input: RetentionDiscountInput,
  ): Promise<{ description: string; appliesTo: string }>;

  // ── invoices ───────────────────────────────────────────────────────────
  getUpcomingInvoice(subscriptionId: string): Promise<ProviderInvoice | null>;
  getInvoice(invoiceId: string): Promise<ProviderInvoice | null>;
  listInvoices(customerId: string): Promise<ProviderInvoice[]>;
  getInvoiceDocument(invoiceId: string): Promise<InvoiceDocument>;

  // ── refunds ────────────────────────────────────────────────────────────
  /**
   * Refunds `amount` of payment `paymentId` (an invoice id) and ends the
   * subscription immediately. Billing state changes arrive as events
   * (charge.refunded, subscription.deleted) for the handler to write.
   */
  refund(paymentId: string, amount: number): Promise<void>;

  // ── customer portal (card updates only) ────────────────────────────────
  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;

  // ── promotions (our engine validates; the provider mirrors) ────────────
  syncPromotion(promo: PromoMirror): Promise<Record<string, string>>;
  deactivatePromotion(promo: PromoMirror): Promise<void>;

  // ── events ─────────────────────────────────────────────────────────────
  /** Verifies the signature over the raw body and returns the event. */
  parseEvent(
    rawBody: Buffer | string,
    signature: string | undefined,
  ): ProviderEvent;
}
