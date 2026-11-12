import type {
  BillingDetails,
  BillingRegion,
  CheckoutQuote,
  ProviderChangeKind,
} from "./types";
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
  /**
   * false for test-mode providers (the fake, Stripe sk_test_ keys). Every
   * billing record written through this provider carries it, so test data is
   * excluded from MRR/revenue/counts and can be purged.
   */
  readonly livemode: boolean;

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
    /** Free-trial days (0 = none): $0 today, the card is set up, the first charge at the end. */
    trialDays?: number;
    /** Name/address/phone for the provider's customer record and tax. */
    billing?: BillingDetails | null;
  }): Promise<CheckoutSession>;
  getCheckout(sessionId: string): Promise<CheckoutSession | null>;
  /**
   * Ids of the customer's subscriptions that bill or can bill (active,
   * trialing, past due, unpaid), read from the provider itself — so a second
   * purchase is refused even before the first one's webhook has arrived.
   */
  liveSubscriptionIds?(customerId: string): Promise<string[]>;
  /**
   * Closes the customer's other unfinished checkouts (an unpaid first invoice,
   * a trial card form not yet confirmed) so a second tab can't complete a
   * second subscription. `keep` is the checkout just created.
   */
  closeOtherCheckouts?(customerId: string, keep: string): Promise<void>;

  // ── subscriptions ──────────────────────────────────────────────────────
  getSubscription(subscriptionId: string): Promise<ProviderSubscription | null>;
  /** Every non-ended subscription, for the nightly reconcile. */
  listSubscriptions(): Promise<ProviderSubscription[]>;
  previewChange(input: {
    subscriptionId: string;
    target: PriceRef;
    kind: ProviderChangeKind;
  }): Promise<ChangePreview>;
  /**
   * upgrade: immediate, prorated, charged now (must equal expectedAmountDue).
   * downgrade: immediate, prorated, credited to the balance (must equal expectedCredit).
   * scheduled: annual → monthly at the end of the annual period.
   */
  changePlan(input: {
    subscriptionId: string;
    target: PriceRef;
    kind: ProviderChangeKind;
    prorationDate: number;
    expectedAmountDue: number | null;
    expectedCredit?: number | null;
    /** The card entered in the payment step for this change (Stripe): it becomes the subscription's card and pays anything due now. */
    paymentMethodId?: string | null;
    /** Name and billing address entered in the payment step. */
    billing?: BillingDetails | null;
  }): Promise<ChangeResult>;
  /** The customer's account credit (minor units, ≥ 0) used on future invoices. */
  getCreditBalance(customerId: string): Promise<number>;
  /** Adds account credit (used automatically on the next invoices, never paid out). Idempotent by key. */
  addCustomerCredit?(input: {
    customerId: string;
    amount: number;
    currency: string;
    description: string;
    idempotencyKey: string;
  }): Promise<void>;
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
  /** Verifies the signature over the raw body and returns the event (null = not ours, ignore). */
  parseEvent(
    rawBody: Buffer | string,
    signature: string | undefined,
  ): ProviderEvent | null | Promise<ProviderEvent | null>;
}
