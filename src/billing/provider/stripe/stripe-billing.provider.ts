/* eslint-disable @typescript-eslint/no-unused-vars -- stub: the named parameters document the contract each TODO must implement */
import type { BillingDetails, BillingRegion, CheckoutQuote } from "../types";
import { NotImplementedException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { BillingProvider } from "../billing-provider";
import type {
  AppliedDiscount,
  ChangePreview,
  ChangeResult,
  CheckoutSession,
  InvoiceDocument,
  PriceRef,
  PromoMirror,
  ProviderEvent,
  ProviderEventType,
  ProviderInvoice,
  ProviderSubscription,
  RetentionDiscountInput,
} from "../types";

/**
 * StripeBillingProvider — STUB. Selected with BILLING_PROVIDER=stripe.
 *
 * Every method documents the exact Stripe API it must call. Implementing this
 * file (plus running scripts/stripe-seed.ts) is the remaining Stripe work; the
 * rest of the app talks only to the BillingProvider interface and is already
 * exercised end to end by FakeBillingProvider.
 *
 * Setup when implementing:
 *   npm install stripe
 *   import Stripe from "stripe";
 *   this.stripe = new Stripe(config.get("STRIPE_SECRET_KEY"), { apiVersion: "<pinned version>" });
 *
 * Config (Secret Manager in staging/production; see docs/PLACEHOLDERS.md):
 *   STRIPE_SECRET_KEY            sk_test_… / sk_live_…
 *   STRIPE_WEBHOOK_SECRET        whsec_… for POST /api/billing/webhook
 *   STRIPE_PORTAL_CONFIGURATION  bpc_… (payment method update + invoice history only)
 *   STRIPE_RETENTION_COUPON_ID   coupon for the monthly retention offer (50%, repeating, 2 months)
 *   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (UI, for Stripe.js 3-D Secure confirmation)
 *
 * Mapping conventions:
 *   - Catalog price → Stripe Price via lookup key (prices.list({ lookup_keys: [ref.lookupKey], active: true })).
 *   - uid lives in metadata on Customer, Checkout Session and Subscription
 *     (metadata.uid), so every event can be tied to a user.
 *   - Amounts are minor units on both sides; no conversion needed.
 */

/** Stripe event type → provider event type the handler understands. */
export const STRIPE_EVENT_MAP: Record<string, ProviderEventType> = {
  "checkout.session.completed": "checkout.completed",
  "checkout.session.expired": "checkout.expired",
  "customer.subscription.created": "subscription.created",
  "customer.subscription.updated": "subscription.updated",
  "customer.subscription.deleted": "subscription.deleted",
  "invoice.paid": "invoice.paid",
  "invoice.payment_failed": "invoice.payment_failed",
  "invoice.payment_action_required": "invoice.action_required",
  "invoice.upcoming": "invoice.upcoming",
  "charge.refunded": "charge.refunded",
  "charge.dispute.created": "charge.dispute_created",
};

export class StripeBillingProvider implements BillingProvider {
  readonly name = "stripe" as const;

  constructor(private readonly config: ConfigService) {}

  private todo(method: string): never {
    throw new NotImplementedException(
      `StripeBillingProvider.${method} is not implemented yet (see the TODO in stripe-billing.provider.ts).`,
    );
  }

  createCustomer(_input: {
    uid: string;
    email: string | null;
  }): Promise<{ customerId: string }> {
    // TODO stripe.customers.create({ email, metadata: { uid } }, { idempotencyKey: `customer-${uid}` })
    //      → { customerId: customer.id }
    return this.todo("createCustomer");
  }

  setCustomerMetadata(
    _customerId: string,
    _metadata: Record<string, string>,
  ): Promise<void> {
    // TODO stripe.customers.update(customerId, { metadata })
    //      (retention: { retention_offer_used: "true", retention_email_hash: <hash> })
    return this.todo("setCustomerMetadata");
  }

  previewCheckout(_input: {
    price: PriceRef;
    discount: AppliedDiscount | null;
    region: BillingRegion | null;
  }): Promise<CheckoutQuote> {
    // TODO Stripe Tax (automatic tax) — no rates in our code or UI:
    //      const [p] = (await stripe.prices.list({ lookup_keys: [price.lookupKey], active: true })).data
    //      const inv = await stripe.invoices.createPreview({
    //        automatic_tax: { enabled: true },
    //        customer_details: { address: { country: region.country, state: region.state, postal_code: region.postalCode } },
    //        subscription_details: { items: [{ price: p.id }] },
    //        discounts: discount?.promoId ? [{ promotion_code: <promo.providerRefs.stripePromotionCodeId> }] : undefined,
    //      })
    //      → { subtotal: inv.subtotal, discount: sum(inv.total_discount_amounts), tax: inv.tax ?? 0,
    //          total: inv.total, taxLabel: inv.total_tax_amounts[0]?.tax_rate display name, taxPending: !region }
    //      Requires Stripe Tax registrations (placeholder: Texas) and the SaaS product tax code
    //      (STRIPE_PRODUCT_TAX_CODE) on the Products created by scripts/stripe-seed.ts.
    return this.todo("previewCheckout");
  }

  createCheckout(_input: {
    uid: string;
    customerId: string;
    price: PriceRef;
    discount: AppliedDiscount | null;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
    billing?: BillingDetails | null;
  }): Promise<CheckoutSession> {
    // TODO (embedded checkout, Payment Element + Address Element):
    //      stripe.customers.update(customerId, { name: billing.name, phone: billing.phone,
    //        address: { line1, line2, city, state, postal_code, country } })   // full address stays at Stripe
    //      const sub = await stripe.subscriptions.create({
    //        customer: customerId, items: [{ price: p.id }],
    //        automatic_tax: { enabled: true },
    //        payment_behavior: "default_incomplete",
    //        payment_settings: { save_default_payment_method: "on_subscription",
    //          payment_method_types: ["card", "link"] /* + "paypal" only if the account supports it; no crypto/UPI */ },
    //        discounts: discount?.promoId ? [{ promotion_code: <stripePromotionCodeId> }] : undefined,
    //        metadata: { uid, planId, interval },
    //        expand: ["latest_invoice.confirmation_secret"],
    //      }, { idempotencyKey })
    //      → CheckoutSession { id: sub.id, clientSecret: sub.latest_invoice.confirmation_secret.client_secret,
    //          amountDueToday: invoice.amount_due, tax: invoice.tax } — the browser confirms with
    //          stripe.confirmPayment({ elements, redirect: "if_required" }) (3-D Secure handled by Stripe).
    //      Legacy hosted Checkout (kept for reference):
    // TODO const [price] = (await stripe.prices.list({ lookup_keys: [price.lookupKey], active: true })).data
    //      stripe.checkout.sessions.create({
    //        mode: "subscription", customer: customerId, client_reference_id: uid,
    //        line_items: [{ price: price.id, quantity: 1 }],
    //        discounts: discount?.promoId ? [{ promotion_code: <promo.providerRefs.stripePromotionCodeId> }] : undefined,
    //        allow_promotion_codes: false,              // codes enter only through our validation
    //        subscription_data: { metadata: { uid, planId, interval } },
    //        metadata: { uid, planId, interval },
    //        success_url: successUrl,                   // contains {CHECKOUT_SESSION_ID}
    //        cancel_url: cancelUrl,
    //      }, { idempotencyKey })
    //      → map to CheckoutSession (url = session.url, expiresAt = session.expires_at)
    return this.todo("createCheckout");
  }

  getCheckout(_sessionId: string): Promise<CheckoutSession | null> {
    // TODO stripe.checkout.sessions.retrieve(sessionId) → CheckoutSession
    return this.todo("getCheckout");
  }

  getSubscription(
    _subscriptionId: string,
  ): Promise<ProviderSubscription | null> {
    // TODO stripe.subscriptions.retrieve(id, { expand: ["discount", "schedule"] })
    //      planId/interval from items.data[0].price.lookup_key; period from items.data[0].current_period_start/end
    //      (or subscription.current_period_* on older API versions); scheduledChange from schedule.phases[1];
    //      pastDueSince = latest_invoice.created when status === "past_due".
    return this.todo("getSubscription");
  }

  listSubscriptions(): Promise<ProviderSubscription[]> {
    // TODO for await (const s of stripe.subscriptions.list({ status: "all", limit: 100 })) — skip ended ones
    return this.todo("listSubscriptions");
  }

  previewChange(_input: {
    subscriptionId: string;
    target: PriceRef;
    kind: "upgrade" | "downgrade";
  }): Promise<ChangePreview> {
    // TODO upgrade: const prorationDate = Math.floor(Date.now() / 1000)
    //      stripe.invoices.createPreview({ customer, subscription: id,
    //        subscription_details: { items: [{ id: itemId, price: targetPriceId }], proration_behavior: "always_invoice",
    //          proration_date: prorationDate, billing_cycle_anchor: intervalChanges ? "now" : undefined } })
    //      → amountDueNow = preview.amount_due; prorationDate returned for changePlan.
    //      downgrade: amountDueNow 0, effectiveAt = current_period_end.
    return this.todo("previewChange");
  }

  changePlan(_input: {
    subscriptionId: string;
    target: PriceRef;
    kind: "upgrade" | "downgrade";
    prorationDate: number;
    expectedAmountDue: number | null;
  }): Promise<ChangeResult> {
    // TODO upgrade: re-run the preview with the same proration_date; if amount_due !== expectedAmountDue → PreviewStaleError.
    //      If the subscription has a schedule (pending downgrade): stripe.subscriptionSchedules.release(scheduleId) first.
    //      stripe.subscriptions.update(id, { items: [{ id: itemId, price: targetPriceId }],
    //        proration_behavior: "always_invoice", proration_date, payment_behavior: "pending_if_incomplete",
    //        cancel_at_period_end: false, billing_cycle_anchor: intervalChanges ? "now" : "unchanged" })
    //      latest_invoice.payment_intent.status === "requires_action" → { status: "requires_action", clientSecret }
    //      failed → { status: "payment_failed" } (pending_if_incomplete leaves the old price in place).
    //      downgrade: stripe.subscriptionSchedules.create({ from_subscription: id }) then
    //        subscriptionSchedules.update(schedule.id, { end_behavior: "release", phases: [
    //          { items: [current], start_date: phase0.start_date, end_date: current_period_end },
    //          { items: [{ price: targetPriceId }], start_date: current_period_end } ] })
    return this.todo("changePlan");
  }

  cancelScheduledChange(_subscriptionId: string): Promise<void> {
    // TODO stripe.subscriptionSchedules.release(subscription.schedule)
    return this.todo("cancelScheduledChange");
  }

  cancelAtPeriodEnd(_subscriptionId: string): Promise<void> {
    // TODO release any schedule, then stripe.subscriptions.update(id, { cancel_at_period_end: true })
    return this.todo("cancelAtPeriodEnd");
  }

  resume(_subscriptionId: string): Promise<void> {
    // TODO stripe.subscriptions.update(id, { cancel_at_period_end: false })
    return this.todo("resume");
  }

  applyRetentionDiscount(
    _input: RetentionDiscountInput,
  ): Promise<{ description: string; appliesTo: string }> {
    // TODO monthly: stripe.subscriptions.update(id, { discounts: [{ coupon: STRIPE_RETENTION_COUPON_ID }],
    //        cancel_at_period_end: false })   // coupon: percent_off 50, duration "repeating", duration_in_months 2
    //      annual: stripe.customers.createBalanceTransaction(customerId, { amount: -amount, currency,
    //        description: "Retention offer credit" }); then subscriptions.update(id, { cancel_at_period_end: false })
    return this.todo("applyRetentionDiscount");
  }

  getUpcomingInvoice(_subscriptionId: string): Promise<ProviderInvoice | null> {
    // TODO stripe.invoices.createPreview({ subscription: id }) (invoices.retrieveUpcoming on older API versions)
    return this.todo("getUpcomingInvoice");
  }

  getInvoice(_invoiceId: string): Promise<ProviderInvoice | null> {
    // TODO stripe.invoices.retrieve(id) → hostedInvoiceUrl = hosted_invoice_url, invoicePdfUrl = invoice_pdf
    return this.todo("getInvoice");
  }

  listInvoices(_customerId: string): Promise<ProviderInvoice[]> {
    // TODO stripe.invoices.list({ customer: customerId, limit: 100 })
    return this.todo("listInvoices");
  }

  getInvoiceDocument(_invoiceId: string): Promise<InvoiceDocument> {
    // TODO const inv = await stripe.invoices.retrieve(id); return { kind: "redirect", url: inv.invoice_pdf ?? inv.hosted_invoice_url }
    return this.todo("getInvoiceDocument");
  }

  createPortalSession(_input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    // TODO stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl,
    //        configuration: STRIPE_PORTAL_CONFIGURATION })   // configured: payment_method_update + invoice_history only
    return this.todo("createPortalSession");
  }

  syncPromotion(_promo: PromoMirror): Promise<Record<string, string>> {
    // TODO const coupon = await stripe.coupons.create({ percent_off | amount_off+currency, duration,
    //        duration_in_months, applies_to: { products: <product ids of appliesToPlans> }, metadata: { promoId } })
    //      const pc = await stripe.promotionCodes.create({ coupon: coupon.id, code, max_redemptions,
    //        expires_at, restrictions: { first_time_transaction: firstTimeOnly }, metadata: { promoId, intervals } })
    //      → { stripeCouponId: coupon.id, stripePromotionCodeId: pc.id }
    //      (interval restrictions have no Stripe equivalent; our engine enforces them before checkout.)
    return this.todo("syncPromotion");
  }

  deactivatePromotion(_promo: PromoMirror): Promise<void> {
    // TODO stripe.promotionCodes.update(promo.providerRefs.stripePromotionCodeId, { active: false })
    return this.todo("deactivatePromotion");
  }

  parseEvent(
    _rawBody: Buffer | string,
    _signature: string | undefined,
  ): ProviderEvent {
    // TODO const e = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET)  // throws → InvalidEventSignatureError
    //      const type = STRIPE_EVENT_MAP[e.type]; ignore unknown types
    //      return { id: e.id, type, created: e.created * 1000, provider: "stripe",
    //        data: { uid: obj.metadata?.uid ?? obj.client_reference_id, customerId: obj.customer,
    //                subscriptionId: obj.subscription ?? (obj.object === "subscription" ? obj.id : null),
    //                invoiceId: obj.object === "invoice" ? obj.id : obj.invoice, checkoutSessionId: obj.object === "checkout.session" ? obj.id : null } }
    return this.todo("parseEvent");
  }
}
