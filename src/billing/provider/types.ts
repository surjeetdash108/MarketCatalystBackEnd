import type { BillingInterval } from "../../plans/plans.registry";

/**
 * Provider-agnostic billing types. Everything the app needs from a payment
 * provider is expressed here; FakeBillingProvider simulates it end to end and
 * StripeBillingProvider maps it to Stripe objects.
 */

export type ProviderName = "fake" | "stripe";

/** A catalog price resolved for the provider (lookup key → provider Price). */
export interface PriceRef {
  planId: string;
  interval: BillingInterval;
  /** Minor units. */
  amount: number;
  currency: string;
  lookupKey: string;
}

export type DiscountDuration = "once" | "repeating" | "forever";

/** A discount attached to a subscription (from a promo code or the retention offer). */
export interface AppliedDiscount {
  source: "promo" | "retention";
  promoId?: string | null;
  code?: string | null;
  percentOff?: number | null;
  /** Minor units. */
  amountOff?: number | null;
  duration: DiscountDuration;
  durationInMonths?: number | null;
  /** Invoices still to receive the discount; null = unlimited (forever). */
  remainingInvoices?: number | null;
  /** When the discount stops applying (ISO), for display. */
  endsAt?: string | null;
}

export type ProviderSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid";

export interface ScheduledChange {
  planId: string;
  interval: BillingInterval;
  effectiveAt: string;
}

export interface ProviderSubscription {
  id: string;
  customerId: string;
  uid: string;
  planId: string;
  interval: BillingInterval;
  priceLookupKey: string;
  /** Recurring amount at the current price, minor units, before discounts. */
  amount: number;
  currency: string;
  status: ProviderSubscriptionStatus;
  startedAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  endedAt: string | null;
  discount: AppliedDiscount | null;
  scheduledChange: ScheduledChange | null;
  pastDueSince: string | null;
  latestInvoiceId: string | null;
  /** Provider timestamp of the last change, ms. */
  updatedAt: number;
}

export type ProviderInvoiceStatus = "open" | "paid" | "void" | "uncollectible";

export interface InvoiceLine {
  description: string;
  /** Minor units; negative for credits. */
  amount: number;
  proration: boolean;
  /** The service period this line covers (ISO), when the provider reports one. */
  periodStart?: string | null;
  periodEnd?: string | null;
}

/**
 * upgrade   immediate, prorated, charged now
 * downgrade immediate, prorated, the difference credited to the customer balance
 * scheduled annual → monthly: takes effect at the end of the annual period
 */
export type ProviderChangeKind = "upgrade" | "downgrade" | "scheduled";

export interface ProviderInvoice {
  id: string;
  number: string;
  customerId: string;
  subscriptionId: string | null;
  uid: string;
  planId: string;
  interval: BillingInterval;
  status: ProviderInvoiceStatus;
  billingReason:
    | "subscription_create"
    | "subscription_cycle"
    | "subscription_update"
    | "upcoming";
  createdAt: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  subtotal: number;
  discountAmount: number;
  creditApplied: number;
  total: number;
  amountPaid: number;
  amountDue: number;
  amountRefunded: number;
  lines: InvoiceLine[];
  discount: AppliedDiscount | null;
  attemptCount: number;
  nextPaymentAttempt: string | null;
  paidAt: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

export type CheckoutStatus = "open" | "complete" | "expired";

export interface CheckoutSession {
  id: string;
  url: string;
  status: CheckoutStatus;
  uid: string;
  customerId: string;
  planId: string;
  interval: BillingInterval;
  discount: AppliedDiscount | null;
  amountDueToday: number;
  currency: string;
  expiresAt: string;
  subscriptionId: string | null;
  successUrl: string;
  cancelUrl: string;
  /** Tax included in amountDueToday (provider-computed). */
  tax?: number;
  /** Embedded checkout: the secret the browser confirms the first payment with (Stripe). */
  clientSecret?: string | null;
}

export interface ChangePreview {
  kind: ProviderChangeKind;
  planId: string;
  interval: BillingInterval;
  currency: string;
  /** Charged now (upgrades); 0 for downgrades. Minor units. */
  amountDueNow: number;
  /** Credited to the customer balance now (downgrades); 0 otherwise. */
  creditToBalance: number;
  /** The current period the proration splits (ISO). */
  currentPeriodStart: string;
  currentPeriodEnd: string;
  /** Proration reference time (ms); pass back to changePlan for the same amount. */
  prorationDate: number;
  effectiveAt: string;
  nextRenewalAmount: number;
  nextRenewalDate: string;
  lines: InvoiceLine[];
}

export type ChangeResult =
  | {
      status: "applied";
      invoiceId: string | null;
      amountCharged: number;
      /** Credited to the customer balance (downgrades). */
      creditToBalance?: number;
      effectiveAt: string;
    }
  | { status: "scheduled"; effectiveAt: string }
  | {
      status: "requires_action";
      actionId: string;
      clientSecret: string | null;
      amountDue: number;
    }
  | { status: "payment_failed"; reason: string };

export type RetentionDiscountInput =
  | {
      subscriptionId: string;
      customerId: string;
      mode: "percent_next_invoices";
      percentOff: number;
      invoices: number;
    }
  | {
      subscriptionId: string;
      customerId: string;
      mode: "balance_credit";
      amount: number;
      currency: string;
    };

export interface PromoMirror {
  id: string;
  code: string;
  percentOff: number | null;
  amountOff: number | null;
  currency: string;
  duration: DiscountDuration;
  durationInMonths: number | null;
  appliesToPlans: string[];
  appliesToIntervals: BillingInterval[];
  expiresAt: string | null;
  maxRedemptions: number | null;
  firstTimeOnly: boolean;
  providerRefs?: Record<string, string>;
}

export type ProviderEventType =
  | "checkout.completed"
  | "checkout.expired"
  | "subscription.created"
  | "subscription.updated"
  | "subscription.deleted"
  | "invoice.paid"
  | "invoice.payment_failed"
  | "invoice.action_required"
  | "invoice.upcoming"
  | "charge.refunded"
  | "charge.dispute_created";

export interface ProviderEvent {
  id: string;
  type: ProviderEventType;
  /** Provider creation time, ms. */
  created: number;
  provider: ProviderName;
  data: {
    uid?: string | null;
    customerId?: string | null;
    subscriptionId?: string | null;
    invoiceId?: string | null;
    checkoutSessionId?: string | null;
    amount?: number | null;
  };
}

export type InvoiceDocument =
  { kind: "redirect"; url: string } | { kind: "html"; html: string };

/** Where the customer is billed — the only part of the address we keep (tax region). */
export interface BillingRegion {
  country: string;
  state: string | null;
  postalCode: string | null;
}

/** Full billing details: passed to the provider, never stored by us (only the region is). */
export interface BillingDetails {
  name: string;
  phone: string;
  address: {
    line1: string;
    line2: string | null;
    city: string;
    state: string | null;
    postalCode: string | null;
    country: string;
  };
}

/** The provider's price for a new subscription: tax comes only from here. */
export interface CheckoutQuote {
  currency: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  /** e.g. "Sales tax (TX)"; null when no tax applies. */
  taxLabel: string | null;
  /** true when the provider could not compute tax yet (no region). */
  taxPending: boolean;
}
