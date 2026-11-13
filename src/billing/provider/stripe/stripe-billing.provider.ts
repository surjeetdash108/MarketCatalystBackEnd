import { createHash } from "crypto";
import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import {
  PLAN_DEFINITIONS,
  type BillingInterval,
} from "../../../plans/plans.registry";
import {
  InvalidEventSignatureError,
  PreviewStaleError,
  type BillingProvider,
} from "../billing-provider";
import type {
  AppliedDiscount,
  BillingDetails,
  BillingRegion,
  ChangePreview,
  ChangeResult,
  CheckoutQuote,
  CheckoutSession,
  InvoiceDocument,
  InvoiceLine,
  PriceRef,
  PromoMirror,
  ProviderEvent,
  ProviderEventType,
  ProviderInvoice,
  ProviderInvoiceStatus,
  ProviderSubscription,
  ProviderSubscriptionStatus,
  RetentionDiscountInput,
  ProviderChangeKind,
} from "../types";

/**
 * StripeBillingProvider — selected with BILLING_PROVIDER=stripe.
 *
 * Embedded checkout ("deferred intent"): the browser collects payment details
 * with the Payment Element + Address Element; POST /api/billing/checkout then
 * creates the subscription here with payment_behavior=default_incomplete and
 * returns the first invoice's confirmation secret; the browser confirms with
 * stripe.confirmPayment (Stripe runs 3-D Secure and reports declines). In our
 * model the checkout "session" id IS the subscription id; Stripe's first
 * invoice.paid (billing_reason=subscription_create) becomes checkout.completed.
 *
 * Mapping conventions:
 *   - catalog price ↔ Stripe Price by lookup key (scripts/stripe-seed.ts creates them);
 *   - uid/planId/interval live in Subscription metadata (and Customer metadata.uid);
 *     scheduled downgrades are Subscription Schedules whose next phase carries the
 *     new metadata, so it follows the plan automatically;
 *   - tax: Stripe Tax (automatic_tax) — no rates in our code;
 *   - amounts are minor units on both sides.
 *
 * Config (Secret Manager / env; see docs/PLACEHOLDERS.md):
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET                    (secrets)
 *   STRIPE_PORTAL_CONFIGURATION   bpc_… (optional; Stripe's default portal otherwise)
 *   STRIPE_RETENTION_COUPON_ID    optional override of the generated retention coupon
 *   STRIPE_PAYMENT_METHOD_TYPES   default "card" (Apple Pay / Google Pay ride on card); never "link";
 *                                 add ",paypal" only if the account supports it — never crypto/UPI.
 *                                 Must match NEXT_PUBLIC_STRIPE_PAYMENT_METHOD_TYPES in the UI.
 */
export const STRIPE_API_VERSION = "2025-08-27.basil" as const;

/** Stripe event type → provider event type the handler understands. */
export const STRIPE_EVENT_MAP: Record<string, ProviderEventType> = {
  "checkout.session.completed": "checkout.completed",
  "checkout.session.expired": "checkout.expired",
  "setup_intent.succeeded": "checkout.card_saved",
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
/** Register exactly these on the webhook endpoint. */
export const STRIPE_WEBHOOK_EVENTS = Object.keys(STRIPE_EVENT_MAP);

// Never Link: its "Save my information for faster checkout" box asks for a
// mobile number. Card only by default.
const ALLOWED_PAYMENT_METHODS = new Set([
  "card",
  "paypal",
  "us_bank_account",
  "cashapp",
  "amazon_pay",
]);
const lineOf = (l: Stripe.InvoiceLineItem): InvoiceLine => ({
  description: l.description ?? "",
  amount: l.amount,
  periodStart: l.period?.start ? new Date(l.period.start * 1000).toISOString() : null,
  periodEnd: l.period?.end ? new Date(l.period.end * 1000).toISOString() : null,
  proration:
    (l as unknown as { proration?: boolean }).proration ??
    (
      l as unknown as {
        parent?: { subscription_item_details?: { proration?: boolean } };
      }
    ).parent?.subscription_item_details?.proration ??
    false,
});
const iso = (sec: number | null | undefined) =>
  sec ? new Date(sec * 1000).toISOString() : null;
const idOf = (
  x: string | { id?: string | null } | null | undefined,
): string | null =>
  x == null ? null : typeof x === "string" ? x : (x.id ?? null);
const sumAmounts = (xs: Array<{ amount: number }> | null | undefined) =>
  (xs ?? []).reduce((a, t) => a + t.amount, 0);

/** lookup key → catalog plan/interval/amount. */
const CATALOG = new Map<
  string,
  {
    planId: string;
    interval: BillingInterval;
    amount: number;
    currency: string;
  }
>(
  PLAN_DEFINITIONS.flatMap((p) =>
    (["monthly", "annual"] as const).flatMap((i) => {
      const pr = p.prices[i];
      return pr
        ? [
            [
              pr.lookupKey,
              {
                planId: p.id,
                interval: i,
                amount: pr.amount,
                currency: p.currency,
              },
            ] as const,
          ]
        : [];
    }),
  ),
);

export class StripeBillingProvider implements BillingProvider {
  readonly name = "stripe" as const;
  private readonly logger = new Logger(StripeBillingProvider.name);
  private client: Stripe | null;
  private readonly priceIds = new Map<string, string>();
  private readonly priceKeys = new Map<string, string>();

  /** `client` is for tests; production builds it from STRIPE_SECRET_KEY on first use. */
  constructor(
    private readonly config: ConfigService,
    client?: Stripe,
  ) {
    this.client = client ?? null;
  }

  /** Live mode only with an sk_live_ key (refused at startup unless STRIPE_LIVE_APPROVED). */
  get livemode(): boolean {
    return String(this.config.get("STRIPE_SECRET_KEY", "") ?? "").startsWith(
      "sk_live_",
    );
  }

  private get stripe(): Stripe {
    if (!this.client) {
      const key = String(this.config.get("STRIPE_SECRET_KEY", "") ?? "");
      if (!key || key.includes("PLACEHOLDER"))
        throw new Error("STRIPE_SECRET_KEY is not configured");
      this.client = new Stripe(key, {
        apiVersion: STRIPE_API_VERSION,
        appInfo: { name: "MarketCatalyst" },
      });
    }
    return this.client;
  }

  private get paymentMethodTypes(): Stripe.SubscriptionCreateParams.PaymentSettings.PaymentMethodType[] {
    const raw = String(
      this.config.get("STRIPE_PAYMENT_METHOD_TYPES", "card") ?? "card",
    );
    const types = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => ALLOWED_PAYMENT_METHODS.has(s));
    return (
      types.length ? types : ["card"]
    ) as Stripe.SubscriptionCreateParams.PaymentSettings.PaymentMethodType[];
  }

  // ── prices ────────────────────────────────────────────────────────────

  private async priceId(lookupKey: string): Promise<string> {
    const hit = this.priceIds.get(lookupKey);
    if (hit) return hit;
    const found = await this.stripe.prices.list({
      lookup_keys: [lookupKey],
      active: true,
      limit: 1,
    });
    const p = found.data[0];
    if (!p)
      throw new Error(
        `No active Stripe Price with lookup key ${lookupKey} (run scripts/stripe-seed.ts)`,
      );
    this.priceIds.set(lookupKey, p.id);
    if (p.lookup_key) this.priceKeys.set(p.id, p.lookup_key);
    return p.id;
  }

  private async lookupKeyOf(
    price: string | Stripe.Price | null | undefined,
  ): Promise<string | null> {
    if (!price) return null;
    if (typeof price !== "string") return price.lookup_key ?? null;
    const hit = this.priceKeys.get(price);
    if (hit) return hit;
    const p = await this.stripe.prices.retrieve(price);
    if (p.lookup_key) this.priceKeys.set(p.id, p.lookup_key);
    return p.lookup_key ?? null;
  }

  // ── discounts ─────────────────────────────────────────────────────────

  /**
   * Our promo engine validates codes; Stripe only applies the result. A coupon
   * with a deterministic id mirrors the discount (created once, then reused).
   */
  async couponFor(d: AppliedDiscount, currency: string): Promise<string> {
    const override = String(
      this.config.get("STRIPE_RETENTION_COUPON_ID", "") ?? "",
    );
    if (
      d.source === "retention" &&
      override &&
      !override.includes("PLACEHOLDER")
    )
      return override;
    const spec: Record<string, unknown> = { duration: d.duration };
    if (d.percentOff != null) spec.percent_off = d.percentOff;
    else {
      spec.amount_off = d.amountOff ?? 0;
      spec.currency = currency.toLowerCase();
    }
    if (d.duration === "repeating")
      spec.duration_in_months = d.durationInMonths ?? 1;
    const id = `mc_${d.source}_${createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16)}`;
    try {
      await this.stripe.coupons.retrieve(id);
    } catch {
      await this.stripe.coupons.create({
        id,
        name:
          d.source === "retention"
            ? "Retention offer"
            : (d.code ?? "Promotion"),
        ...spec,
      } as Stripe.CouponCreateParams);
    }
    return id;
  }

  private discountOf(sub: Stripe.Subscription): AppliedDiscount | null {
    const d = (sub.discounts ?? []).find(
      (x): x is Stripe.Discount => typeof x !== "string",
    );
    if (!d) return null;
    const raw = d as unknown as {
      coupon?: Stripe.Coupon | string;
      source?: { coupon?: Stripe.Coupon | string };
    };
    const c = raw.coupon ?? raw.source?.coupon;
    if (!c || typeof c === "string") return null;
    const override = String(
      this.config.get("STRIPE_RETENTION_COUPON_ID", "") ?? "",
    );
    return {
      source:
        c.id.startsWith("mc_retention") ||
        (override !== "" && c.id === override)
          ? "retention"
          : "promo",
      code:
        (typeof d.promotion_code === "object" && d.promotion_code
          ? d.promotion_code.code
          : null) ??
        c.name ??
        null,
      percentOff: c.percent_off ?? null,
      amountOff: c.amount_off ?? null,
      duration: c.duration,
      durationInMonths: c.duration_in_months ?? null,
      endsAt: iso(d.end),
    };
  }

  // ── customers ─────────────────────────────────────────────────────────

  async createCustomer(input: {
    uid: string;
    email: string | null;
  }): Promise<{ customerId: string }> {
    const c = await this.stripe.customers.create(
      { email: input.email ?? undefined, metadata: { uid: input.uid } },
      { idempotencyKey: `customer-${input.uid}` },
    );
    return { customerId: c.id };
  }

  async setCustomerMetadata(
    customerId: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.stripe.customers.update(customerId, { metadata });
  }


  // ── checkout ──────────────────────────────────────────────────────────

  /** Name and billing address on the customer. The full address stays at Stripe (Stripe Tax uses it). */
  private async applyBilling(
    customerId: string,
    billing: BillingDetails,
  ): Promise<void> {
    const a = billing.address;
    await this.stripe.customers.update(customerId, {
      name: billing.name,
      address: {
        line1: a.line1,
        line2: a.line2 ?? undefined,
        city: a.city,
        state: a.state ?? undefined,
        postal_code: a.postalCode ?? undefined,
        country: a.country,
      },
    });
  }

  async previewCheckout(input: {
    price: PriceRef;
    discount: AppliedDiscount | null;
    region: BillingRegion | null;
  }): Promise<CheckoutQuote> {
    const price = await this.priceId(input.price.lookupKey);
    const coupon = input.discount
      ? await this.couponFor(input.discount, input.price.currency)
      : null;
    let inv: Stripe.Invoice;
    try {
      inv = await this.stripe.invoices.createPreview({
        automatic_tax: { enabled: !!input.region },
        ...(input.region
          ? {
              customer_details: {
                address: {
                  country: input.region.country,
                  state: input.region.state ?? undefined,
                  postal_code: input.region.postalCode ?? undefined,
                },
              },
            }
          : {}),
        subscription_details: { items: [{ price }] },
        ...(coupon ? { discounts: [{ coupon }] } : {}),
      });
    } catch (taxErr) {
      this.logger.warn(
        `Stripe preview with automatic_tax failed: ${(taxErr as Error).message}; falling back without automatic tax`,
      );
      inv = await this.stripe.invoices.createPreview({
        subscription_details: { items: [{ price }] },
        ...(coupon ? { discounts: [{ coupon }] } : {}),
      });
    }
    const tax = sumAmounts(inv.total_taxes);
    return {
      currency: inv.currency.toUpperCase(),
      // The first charge (after any trial — the service works out "due today").
      subtotal: inv.subtotal,
      discount: sumAmounts(inv.total_discount_amounts),
      tax,
      total: inv.total,
      taxLabel: tax > 0 ? "Sales tax" : null,
      taxPending: !input.region,
    };
  }

  async createCheckout(input: {
    uid: string;
    customerId: string;
    price: PriceRef;
    discount: AppliedDiscount | null;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
    billing?: BillingDetails | null;
    trialDays?: number;
  }): Promise<CheckoutSession> {
    if (input.billing) await this.applyBilling(input.customerId, input.billing);
    const price = await this.priceId(input.price.lookupKey);
    const coupon = input.discount
      ? await this.couponFor(input.discount, input.price.currency)
      : null;
    const trial = (input.trialDays ?? 0) > 0;
    if (trial) {
      // Card first: the trial starts only once the card is saved (SetupIntent
      // confirmed in the Payment Element). $0 today; Stripe keeps the card and
      // charges it when the trial ends unless the customer cancels.
      const si = await this.stripe.setupIntents.create(
        {
          customer: input.customerId,
          usage: "off_session",
          payment_method_types: this.paymentMethodTypes,
          metadata: {
            uid: input.uid,
            planId: input.price.planId,
            interval: input.price.interval,
            lookupKey: input.price.lookupKey,
            trialDays: String(input.trialDays),
            coupon: coupon ?? "",
            currency: input.price.currency,
          },
        },
        { idempotencyKey: `trial-setup-${input.idempotencyKey}` },
      );
      return this.trialSessionOf(si, input.successUrl, input.cancelUrl);
    }
    const sub = await this.stripe.subscriptions.create(
      {
        customer: input.customerId,
        items: [{ price }],
        payment_behavior: "default_incomplete",
        payment_settings: {
          save_default_payment_method: "on_subscription",
          payment_method_types: this.paymentMethodTypes,
        },
        automatic_tax: { enabled: true },
        // Trial: no charge today; the card is collected with the pending
        // SetupIntent, and without a card the trial simply ends (no charge).
        ...(trial
          ? {
              trial_period_days: input.trialDays,
              trial_settings: {
                end_behavior: { missing_payment_method: "cancel" as const },
              },
            }
          : {}),
        ...(coupon ? { discounts: [{ coupon }] } : {}),
        metadata: {
          uid: input.uid,
          planId: input.price.planId,
          interval: input.price.interval,
        },
        expand: trial
          ? [
              "latest_invoice.confirmation_secret",
              "pending_setup_intent",
            ]
          : ["latest_invoice.confirmation_secret"],
      },
      { idempotencyKey: `checkout-${input.idempotencyKey}` },
    );
    return this.sessionOf(sub, input.successUrl, input.cancelUrl);
  }

  private sessionOf(
    sub: Stripe.Subscription,
    successUrl = "",
    cancelUrl = "",
  ): CheckoutSession {
    const inv =
      typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
    const item = sub.items.data[0];
    const cat = CATALOG.get(item?.price?.lookup_key ?? "");
    const status =
      sub.status === "active" || sub.status === "trialing"
        ? "complete"
        : sub.status === "incomplete_expired"
          ? "expired"
          : "open";
    const trialing = sub.status === "trialing";
    const setupSecret =
      typeof sub.pending_setup_intent === "object"
        ? sub.pending_setup_intent?.client_secret
        : null;
    return {
      id: sub.id,
      url: "",
      status,
      uid: sub.metadata?.uid ?? "",
      customerId: idOf(sub.customer) ?? "",
      planId: sub.metadata?.planId || cat?.planId || "",
      interval:
        (sub.metadata?.interval as BillingInterval) ||
        cat?.interval ||
        "monthly",
      discount: this.discountOf(sub),
      amountDueToday:
        trialing
          ? 0
          : inv
            ? status === "complete"
              ? inv.amount_paid
              : inv.amount_due
            : 0,
      tax: trialing ? 0 : inv ? sumAmounts(inv.total_taxes) : 0,
      currency: (inv?.currency ?? item?.price?.currency ?? "usd").toUpperCase(),
      expiresAt: iso(sub.created + 23 * 3600) ?? new Date().toISOString(),
      subscriptionId: sub.id,
      successUrl: successUrl.replace("{CHECKOUT_SESSION_ID}", sub.id),
      cancelUrl,
      // Trial: the card is confirmed with the SetupIntent; otherwise the first invoice's payment.
      clientSecret: trialing
        ? (setupSecret ?? null)
        : (inv?.confirmation_secret?.client_secret ?? setupSecret ?? null),
    };
  }

  /** A free-trial checkout: its id is the SetupIntent's; complete once the trial subscription exists. */
  private trialSessionOf(
    si: Stripe.SetupIntent,
    successUrl = "",
    cancelUrl = "",
  ): CheckoutSession {
    const md = si.metadata ?? {};
    const subscriptionId = md.subscriptionId || null;
    return {
      id: si.id,
      url: "",
      status:
        subscriptionId
          ? "complete"
          : si.status === "canceled" || md.blocked
            ? "expired"
            : "open",
      uid: md.uid ?? "",
      customerId: idOf(si.customer) ?? "",
      planId: md.planId ?? "",
      interval: (md.interval as BillingInterval) || "monthly",
      discount: null,
      amountDueToday: 0,
      tax: 0,
      currency: (md.currency || "usd").toUpperCase(),
      expiresAt: iso(si.created + 23 * 3600) ?? new Date().toISOString(),
      subscriptionId,
      successUrl: successUrl.replace("{CHECKOUT_SESSION_ID}", si.id),
      cancelUrl,
      clientSecret: si.client_secret ?? null,
    };
  }

  async liveSubscriptionIds(customerId: string): Promise<string[]> {
    const out: string[] = [];
    for await (const s of this.stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    })) {
      if (["active", "trialing", "past_due", "unpaid"].includes(s.status))
        out.push(s.id);
    }
    return out;
  }

  async closeOtherCheckouts(customerId: string, keep: string): Promise<void> {
    for await (const s of this.stripe.subscriptions.list({
      customer: customerId,
      status: "incomplete",
      limit: 100,
    })) {
      if (s.id !== keep) await this.stripe.subscriptions.cancel(s.id);
    }
    for await (const si of this.stripe.setupIntents.list({
      customer: customerId,
      limit: 100,
    })) {
      if (
        si.id !== keep &&
        si.metadata?.planId &&
        ["requires_payment_method", "requires_confirmation", "requires_action"].includes(si.status)
      )
        await this.stripe.setupIntents.cancel(si.id);
    }
  }

  /**
   * After the trial's card is saved: create the trialing subscription with that
   * card as its default payment method. Idempotent (keyed by the SetupIntent),
   * so the webhook and a status check can both call it. Never a second
   * subscription: if the customer already has one, the trial isn't started.
   */
  private async startTrialFromSetup(si: Stripe.SetupIntent): Promise<Stripe.SetupIntent> {
    const md = si.metadata ?? {};
    if (si.status !== "succeeded" || md.subscriptionId || md.blocked) return si;
    const customerId = idOf(si.customer)!;
    if ((await this.liveSubscriptionIds(customerId)).length > 0) {
      this.logger.warn(`trial ${si.id} not started: customer ${customerId} already has a subscription`);
      return this.stripe.setupIntents.update(si.id, {
        metadata: { ...md, blocked: "already_subscribed" },
      });
    }
    const price = await this.priceId(md.lookupKey);
    const sub = await this.stripe.subscriptions.create(
      {
        customer: idOf(si.customer)!,
        items: [{ price }],
        default_payment_method: idOf(si.payment_method as string | Stripe.PaymentMethod | null)!,
        trial_period_days: Number(md.trialDays),
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
        automatic_tax: { enabled: true },
        ...(md.coupon ? { discounts: [{ coupon: md.coupon }] } : {}),
        metadata: { uid: md.uid, planId: md.planId, interval: md.interval, setupIntentId: si.id },
      },
      { idempotencyKey: `trial-${si.id}` },
    );
    return this.stripe.setupIntents.update(si.id, {
      metadata: { ...md, subscriptionId: sub.id },
    });
  }

  async getCheckout(sessionId: string): Promise<CheckoutSession | null> {
    if (sessionId.startsWith("seti_")) {
      try {
        const si = await this.startTrialFromSetup(
          await this.stripe.setupIntents.retrieve(sessionId),
        );
        return this.trialSessionOf(si);
      } catch {
        return null;
      }
    }
    try {
      return this.sessionOf(
        await this.stripe.subscriptions.retrieve(sessionId, {
          expand: ["latest_invoice", "discounts"],
        }),
      );
    } catch {
      return null;
    }
  }

  // ── subscriptions ─────────────────────────────────────────────────────

  private async mapSubscription(
    sub: Stripe.Subscription,
  ): Promise<ProviderSubscription> {
    const item = sub.items.data[0];
    const key = item?.price?.lookup_key ?? "";
    const cat = CATALOG.get(key);
    let scheduledChange: ProviderSubscription["scheduledChange"] = null;
    const sched =
      typeof sub.schedule === "string"
        ? await this.stripe.subscriptionSchedules.retrieve(sub.schedule)
        : (sub.schedule ?? null);
    if (sched && sched.status === "active") {
      const now = Math.floor(Date.now() / 1000);
      const next = sched.phases.find((p) => p.start_date > now);
      const nextKey = next
        ? await this.lookupKeyOf(next.items[0]?.price as string | Stripe.Price)
        : null;
      const nextCat = nextKey ? CATALOG.get(nextKey) : null;
      if (next && nextCat)
        scheduledChange = {
          planId: nextCat.planId,
          interval: nextCat.interval,
          effectiveAt: iso(next.start_date)!,
        };
    }
    const inv =
      typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
    const status = (
      sub.status === "paused" ? "unpaid" : sub.status
    ) as ProviderSubscriptionStatus;
    return {
      id: sub.id,
      customerId: idOf(sub.customer) ?? "",
      uid: sub.metadata?.uid ?? "",
      planId: cat?.planId ?? sub.metadata?.planId ?? "",
      interval:
        cat?.interval ??
        ((sub.metadata?.interval as BillingInterval) || "monthly"),
      priceLookupKey: key,
      amount: item?.price?.unit_amount ?? cat?.amount ?? 0,
      currency: (item?.price?.currency ?? "usd").toUpperCase(),
      status,
      startedAt: iso(sub.start_date)!,
      currentPeriodStart: iso(item?.current_period_start)!,
      currentPeriodEnd: iso(item?.current_period_end)!,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      canceledAt: iso(sub.canceled_at),
      endedAt: iso(sub.ended_at),
      discount: this.discountOf(sub),
      scheduledChange,
      pastDueSince:
        status === "past_due" && inv
          ? iso(inv.status_transitions?.finalized_at ?? inv.created)
          : null,
      latestInvoiceId: idOf(
        sub.latest_invoice as string | Stripe.Invoice | null,
      ),
      updatedAt: Date.now(),
    };
  }

  private retrieveSub(id: string) {
    return this.stripe.subscriptions.retrieve(id, {
      expand: ["latest_invoice", "discounts.promotion_code", "schedule"],
    });
  }

  async getSubscription(
    subscriptionId: string,
  ): Promise<ProviderSubscription | null> {
    try {
      return await this.mapSubscription(await this.retrieveSub(subscriptionId));
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }
  }

  async listSubscriptions(): Promise<ProviderSubscription[]> {
    const out: ProviderSubscription[] = [];
    for await (const s of this.stripe.subscriptions.list({
      status: "all",
      limit: 100,
      expand: ["data.latest_invoice", "data.discounts"],
    })) {
      if (
        s.status === "canceled" ||
        s.status === "incomplete_expired" ||
        s.status === "incomplete"
      )
        continue;
      out.push(await this.mapSubscription(s));
    }
    return out;
  }

  /**
   * Upgrades charge now; a change of interval restarts the billing period
   * (anchor now) — except in the free trial: Stripe refuses an anchor before
   * the trial end, and the trial must keep running (first charge at its end).
   */
  private changeParams(
    sub: Stripe.Subscription,
    target: PriceRef,
    priceId: string,
    prorationDate: number,
  ) {
    const item = sub.items.data[0];
    const intervalChange =
      CATALOG.get(item.price.lookup_key ?? "")?.interval !== target.interval;
    const trialing = sub.status === "trialing";
    return {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: "always_invoice" as const,
      proration_date: Math.floor(prorationDate / 1000),
      ...(intervalChange && !trialing
        ? { billing_cycle_anchor: "now" as const }
        : {}),
    };
  }

  /**
   * What the customer actually paid for the current plan in the current
   * period: the paid invoice lines for the subscription's current price that
   * end at the current period end, net of their discounts, before tax. Covers
   * a renewal (one full-period line) and an earlier mid-period change (a
   * "remaining time" proration line). null when it can't be read.
   */
  private async paidForCurrentPeriod(
    sub: Stripe.Subscription,
  ): Promise<number | null> {
    const item = sub.items.data[0];
    if (!item) return null;
    const priceId = item.price.id;
    const periodEnd = item.current_period_end;
    try {
      const list = await this.stripe.invoices.list({
        subscription: sub.id,
        status: "paid",
        limit: 10,
      });
      let paid = 0;
      let found = false;
      for (const inv of list?.data ?? []) {
        for (const l of inv.lines?.data ?? []) {
          const raw = l as unknown as {
            pricing?: { price_details?: { price?: string | { id?: string } } };
            price?: string | { id?: string };
            discount_amounts?: Array<{ amount: number }>;
          };
          const lp = raw.pricing?.price_details?.price ?? raw.price ?? null;
          const linePrice = typeof lp === "string" ? lp : (lp?.id ?? null);
          if (linePrice !== priceId || l.period?.end !== periodEnd || l.amount <= 0)
            continue;
          paid += l.amount - sumAmounts(raw.discount_amounts);
          found = true;
        }
      }
      return found ? paid : null;
    } catch (err) {
      this.logger.warn(
        `paid-for-period lookup failed for ${sub.id}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  async getCreditBalance(customerId: string): Promise<number> {
    const c = await this.stripe.customers.retrieve(customerId);
    // Stripe: a negative balance is credit the customer can spend.
    const bal = (c as Stripe.Customer).balance ?? 0;
    return bal < 0 ? -bal : 0;
  }

  async addCustomerCredit(input: {
    customerId: string;
    amount: number;
    currency: string;
    description: string;
    idempotencyKey: string;
  }): Promise<void> {
    await this.stripe.customers.createBalanceTransaction(
      input.customerId,
      {
        amount: -Math.abs(input.amount),
        currency: input.currency.toLowerCase(),
        description: input.description,
      },
      { idempotencyKey: input.idempotencyKey },
    );
  }

  async previewChange(input: {
    subscriptionId: string;
    target: PriceRef;
    kind: ProviderChangeKind;
  }): Promise<ChangePreview> {
    const sub = await this.retrieveSub(input.subscriptionId);
    const current = await this.mapSubscription(sub);
    const prorationDate = Date.now();
    const period = {
      currentPeriodStart: current.currentPeriodStart,
      currentPeriodEnd: current.currentPeriodEnd,
    };
    if (input.kind === "scheduled") {
      return {
        kind: "scheduled",
        planId: input.target.planId,
        interval: input.target.interval,
        currency: input.target.currency,
        amountDueNow: 0,
        creditToBalance: 0,
        ...period,
        prorationDate,
        effectiveAt: current.currentPeriodEnd,
        nextRenewalAmount: input.target.amount,
        nextRenewalDate: current.currentPeriodEnd,
        lines: [],
      };
    }
    const priceId = await this.priceId(input.target.lookupKey);
    const p = this.changeParams(sub, input.target, priceId, prorationDate);
    const inv = await this.stripe.invoices.createPreview({
      customer: idOf(sub.customer)!,
      subscription: sub.id,
      subscription_details: {
        items: p.items,
        proration_behavior: p.proration_behavior,
        proration_date: p.proration_date,
        ...(p.billing_cycle_anchor
          ? { billing_cycle_anchor: p.billing_cycle_anchor }
          : {}),
      },
    });
    const lines: InvoiceLine[] = inv.lines.data.map(lineOf);
    const nextEnd = inv.lines.data
      .map((l) => l.period?.end ?? 0)
      .filter((x) => x > 0)
      .sort((a, b) => a - b)
      .at(-1);
    // A downgrade's proration invoice totals < 0: Stripe credits the customer balance.
    const net = inv.total;
    const discount = sumAmounts(inv.total_discount_amounts);
    const tax = sumAmounts(inv.total_taxes);
    const creditUsed =
      inv.total > 0 ? Math.max(0, inv.total - inv.amount_due) : 0;
    const unusedCredit = -lines
      .filter((l) => l.proration && l.amount < 0)
      .reduce((a, l) => a + l.amount, 0);
    const newPlanCharge = lines
      .filter((l) => l.amount > 0)
      .reduce((a, l) => a + l.amount, 0);

    const alreadyPaid =
      sub.status === "trialing" ? 0 : await this.paidForCurrentPeriod(sub);

    return {
      kind: input.kind,
      planId: input.target.planId,
      interval: input.target.interval,
      currency: inv.currency.toUpperCase(),
      amountDueNow: input.kind === "upgrade" ? Math.max(0, inv.amount_due) : 0,
      creditToBalance: input.kind === "downgrade" ? Math.max(0, -net) : 0,
      ...period,
      prorationDate,
      effectiveAt: new Date(prorationDate).toISOString(),
      nextRenewalAmount: input.target.amount,
      nextRenewalDate: iso(nextEnd) ?? current.currentPeriodEnd,
      lines,
      discount,
      tax,
      creditUsed,
      alreadyPaid,
      unusedCredit,
      newPlanCharge,
    };
  }

  async changePlan(input: {
    subscriptionId: string;
    target: PriceRef;
    kind: ProviderChangeKind;
    prorationDate: number;
    expectedAmountDue: number | null;
    expectedCredit?: number | null;
    paymentMethodId?: string | null;
    billing?: BillingDetails | null;
  }): Promise<ChangeResult> {
    const sub = await this.retrieveSub(input.subscriptionId);
    const priceId = await this.priceId(input.target.lookupKey);
    const scheduleId = idOf(
      sub.schedule as string | Stripe.SubscriptionSchedule | null,
    );
    const customer = idOf(sub.customer)!;
    const metadata = {
      ...sub.metadata,
      planId: input.target.planId,
      interval: input.target.interval,
    };
    // The charge (or credit) must equal the preview exactly, or nothing changes.
    if (input.kind !== "scheduled") {
      const expected =
        input.kind === "upgrade"
          ? input.expectedAmountDue
          : (input.expectedCredit ?? null);
      if (expected != null) {
        const fresh = await this.previewChange({
          subscriptionId: sub.id,
          target: input.target,
          kind: input.kind,
        });
        const actual =
          input.kind === "upgrade" ? fresh.amountDueNow : fresh.creditToBalance;
        if (actual !== expected) throw new PreviewStaleError(expected, actual);
      }
    }
    // Every change is paid like a first purchase: the card and billing address
    // entered in the payment step become the subscription's — that card pays
    // anything due now and every later renewal. A separate update, because
    // Stripe accepts only proration fields together with pending_if_incomplete.
    if (input.billing) await this.applyBilling(customer, input.billing);
    if (input.paymentMethodId) {
      await this.stripe.paymentMethods.attach(input.paymentMethodId, {
        customer,
      });
      await this.stripe.subscriptions.update(sub.id, {
        default_payment_method: input.paymentMethodId,
      });
    }
    if (input.kind === "scheduled") {
      // Lower plan or annual → monthly: keep the current plan to period end,
      // then the new price via a schedule. In the free trial the first phase
      // keeps the trial end — without it Stripe ends the trial at once.
      const item = sub.items.data[0];
      const schedId =
        scheduleId ??
        (
          await this.stripe.subscriptionSchedules.create({
            from_subscription: sub.id,
          })
        ).id;
      const trialEnd = sub.status === "trialing" ? sub.trial_end : null;
      // A discount the customer has (retention offer, promo) carries into the
      // new plan — schedule phases without it drop it at the switch.
      const discounts = this.discountRefs(sub);
      await this.stripe.subscriptionSchedules.update(schedId, {
        end_behavior: "release",
        phases: [
          {
            items: [{ price: item.price.id }],
            start_date: item.current_period_start,
            end_date: item.current_period_end,
            ...(trialEnd ? { trial_end: trialEnd } : {}),
            ...(discounts.length ? { discounts } : {}),
            metadata: { ...sub.metadata },
          },
          {
            items: [{ price: priceId }],
            ...(discounts.length ? { discounts } : {}),
            metadata,
            proration_behavior: "none",
          },
        ],
      });
      return {
        status: "scheduled",
        effectiveAt: iso(item.current_period_end)!,
      };
    }
    // A change drops a pending (scheduled) change.
    if (scheduleId) await this.stripe.subscriptionSchedules.release(scheduleId);
    const p = this.changeParams(
      sub,
      input.target,
      priceId,
      input.prorationDate,
    );
    // Only fields Stripe supports with pending_if_incomplete: nothing changes
    // unless the prorated invoice is paid.
    const updated = await this.stripe.subscriptions.update(sub.id, {
      ...p,
      payment_behavior: "pending_if_incomplete",
      expand: ["latest_invoice.confirmation_secret"],
    });
    const inv =
      typeof updated.latest_invoice === "object"
        ? updated.latest_invoice
        : null;
    if (!updated.pending_update) {
      // Applied: record the plan on the subscription; an upgrade resumes a
      // cancelling plan, a downgrade keeps its cancel date.
      await this.stripe.subscriptions.update(sub.id, {
        metadata,
        ...(input.kind === "upgrade" ? { cancel_at_period_end: false } : {}),
      });
      return {
        status: "applied",
        invoiceId: inv?.id ?? null,
        amountCharged: inv?.amount_paid ?? 0,
        ...(input.kind === "downgrade"
          ? { creditToBalance: Math.max(0, -(inv?.total ?? 0)) }
          : {}),
        effectiveAt: new Date().toISOString(),
      };
    }
    const secret = inv?.confirmation_secret?.client_secret ?? null;
    if (inv && secret) {
      // The bank must confirm (3-D Secure). Tag the invoice with the change so
      // the rest of it (plan metadata, and an upgrade resuming a cancelling
      // plan) is finished when it is paid — see completePendingChange().
      if (inv.id)
        await this.stripe.invoices.update(inv.id, {
          metadata: {
            ...(inv.metadata ?? {}),
            mc_change: input.kind,
            mc_plan: input.target.planId,
            mc_interval: input.target.interval,
          },
        });
      return {
        status: "requires_action",
        actionId: inv.id ?? "",
        clientSecret: secret,
        amountDue: inv.amount_due,
      };
    }
    return { status: "payment_failed", reason: "card_declined" };
  }

  /**
   * Finishes a plan change whose payment needed bank confirmation: once the
   * tagged invoice is paid and Stripe has applied the pending update, record
   * the new plan on the subscription and — for an upgrade — clear a pending
   * cancellation. Idempotent; does nothing for any other invoice.
   */
  async completePendingChange(invoiceId: string): Promise<boolean> {
    const inv = await this.stripe.invoices.retrieve(invoiceId);
    const md = (inv.metadata ?? {}) as Record<string, string>;
    if (!md.mc_change || !md.mc_plan || inv.status !== "paid") return false;
    const subId = idOf(
      (inv.parent?.subscription_details?.subscription ?? null) as
        | string
        | Stripe.Subscription
        | null,
    );
    if (!subId) return false;
    const sub = await this.stripe.subscriptions.retrieve(subId);
    if (sub.pending_update) return false;
    const resume = md.mc_change === "upgrade" && sub.cancel_at_period_end;
    if (sub.metadata?.planId === md.mc_plan && sub.metadata?.interval === md.mc_interval && !resume) return false;
    await this.stripe.subscriptions.update(sub.id, {
      metadata: { ...sub.metadata, planId: md.mc_plan, interval: md.mc_interval },
      ...(resume ? { cancel_at_period_end: false } : {}),
    });
    return true;
  }

  async cancelScheduledChange(subscriptionId: string): Promise<void> {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
    const s = idOf(sub.schedule as string | Stripe.SubscriptionSchedule | null);
    if (s) await this.stripe.subscriptionSchedules.release(s);
  }

  async cancelAtPeriodEnd(subscriptionId: string): Promise<void> {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
    const s = idOf(sub.schedule as string | Stripe.SubscriptionSchedule | null);
    if (s) await this.stripe.subscriptionSchedules.release(s);
    await this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  }

  async resume(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });
  }

  /** The subscription's current discounts as references a schedule phase can carry. */
  private discountRefs(sub: Stripe.Subscription): Array<{ discount: string }> {
    return (sub.discounts ?? [])
      .map((d) => (typeof d === "string" ? d : d.id))
      .filter(Boolean)
      .map((id) => ({ discount: id }));
  }

  /** Rewrites an active schedule's current and future phases with the subscription's discounts. */
  private async carryDiscountsIntoSchedule(subscriptionId: string): Promise<void> {
    const sub = await this.retrieveSub(subscriptionId);
    const sched =
      typeof sub.schedule === "string"
        ? await this.stripe.subscriptionSchedules.retrieve(sub.schedule)
        : (sub.schedule ?? null);
    if (!sched || sched.status !== "active") return;
    const discounts = this.discountRefs(sub);
    const now = Math.floor(Date.now() / 1000);
    const phases = sched.phases
      .filter((ph) => !ph.end_date || ph.end_date > now)
      .map((ph) => ({
        items: ph.items.map((i) => ({
          price: typeof i.price === "string" ? i.price : i.price.id,
        })),
        start_date: ph.start_date,
        ...(ph.end_date ? { end_date: ph.end_date } : {}),
        ...(ph.trial_end ? { trial_end: ph.trial_end } : {}),
        metadata: { ...(ph.metadata ?? {}) },
        ...(ph.proration_behavior ? { proration_behavior: ph.proration_behavior } : {}),
        ...(discounts.length ? { discounts } : {}),
      }));
    await this.stripe.subscriptionSchedules.update(sched.id, {
      end_behavior: "release",
      phases,
    } as Stripe.SubscriptionScheduleUpdateParams);
  }

  async applyRetentionDiscount(
    input: RetentionDiscountInput,
  ): Promise<{ description: string; appliesTo: string }> {
    if (input.mode === "percent_next_invoices") {
      const coupon = await this.couponFor(
        {
          source: "retention",
          percentOff: input.percentOff,
          duration: "repeating",
          durationInMonths: input.invoices,
        },
        "USD",
      );
      await this.stripe.subscriptions.update(input.subscriptionId, {
        discounts: [{ coupon }],
      });
      // With a scheduled change pending, the schedule's phases must carry the
      // discount too, or it is dropped when the new plan starts.
      await this.carryDiscountsIntoSchedule(input.subscriptionId);
      return {
        description: `${input.percentOff}% off your next ${input.invoices} invoices`,
        appliesTo: "next_invoices",
      };
    }
    await this.stripe.customers.createBalanceTransaction(input.customerId, {
      amount: -Math.abs(input.amount),
      currency: input.currency.toLowerCase(),
      description: "Retention offer credit",
    });
    return {
      description: `${(input.amount / 100).toFixed(2)} ${input.currency} credit on your next invoice`,
      appliesTo: "next_invoice",
    };
  }

  // ── invoices ──────────────────────────────────────────────────────────

  private async mapInvoice(
    inv: Stripe.Invoice,
    billingReason?: ProviderInvoice["billingReason"],
  ): Promise<ProviderInvoice> {
    const sd = inv.parent?.subscription_details ?? null;
    const subId = idOf(
      sd?.subscription as string | Stripe.Subscription | null | undefined,
    );
    let planId = sd?.metadata?.planId ?? "";
    let interval = (sd?.metadata?.interval as BillingInterval) || "monthly";
    const line0 = inv.lines?.data?.[0] as unknown as
      | {
          pricing?: { price_details?: { price?: string | Stripe.Price } };
          period?: { start: number; end: number };
        }
      | undefined;
    const key = await this.lookupKeyOf(
      line0?.pricing?.price_details?.price ?? null,
    ).catch(() => null);
    const cat = key ? CATALOG.get(key) : null;
    if (cat) {
      planId = cat.planId;
      interval = cat.interval;
    }
    const reason: ProviderInvoice["billingReason"] =
      billingReason ??
      (inv.billing_reason === "subscription_create"
        ? "subscription_create"
        : inv.billing_reason === "subscription_cycle"
          ? "subscription_cycle"
          : "subscription_update");
    return {
      id: inv.id ?? "upcoming",
      number: inv.number ?? "",
      customerId: idOf(inv.customer) ?? "",
      subscriptionId: subId,
      uid: sd?.metadata?.uid ?? "",
      planId,
      interval,
      status: (inv.status === "draft" || !inv.status
        ? "open"
        : inv.status) as ProviderInvoiceStatus,
      billingReason: reason,
      createdAt: iso(inv.created)!,
      periodStart: iso(line0?.period?.start ?? inv.period_start)!,
      periodEnd: iso(line0?.period?.end ?? inv.period_end)!,
      currency: inv.currency.toUpperCase(),
      subtotal: inv.subtotal,
      discountAmount: sumAmounts(inv.total_discount_amounts),
      creditApplied: Math.max(
        0,
        (inv.starting_balance ?? 0) - (inv.ending_balance ?? 0),
      ),
      total: inv.total,
      amountPaid: inv.amount_paid,
      amountDue: inv.amount_remaining,
      amountRefunded: Number(inv.metadata?.amount_refunded ?? 0) || 0,
      lines: (inv.lines?.data ?? []).map(lineOf),
      discount: null,
      attemptCount: inv.attempt_count,
      nextPaymentAttempt: iso(inv.next_payment_attempt),
      paidAt: iso(inv.status_transitions?.paid_at),
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      invoicePdfUrl: inv.invoice_pdf ?? null,
    };
  }

  async getUpcomingInvoice(
    subscriptionId: string,
  ): Promise<ProviderInvoice | null> {
    try {
      const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
      if (sub.cancel_at_period_end || sub.ended_at) return null;
      const inv = await this.stripe.invoices.createPreview({
        subscription: subscriptionId,
        customer: idOf(sub.customer)!,
      });
      const mapped = await this.mapInvoice(inv, "upcoming");
      return {
        ...mapped,
        uid: mapped.uid || sub.metadata?.uid || "",
        subscriptionId,
      };
    } catch {
      return null;
    }
  }

  async getInvoice(invoiceId: string): Promise<ProviderInvoice | null> {
    try {
      return await this.mapInvoice(
        await this.stripe.invoices.retrieve(invoiceId),
      );
    } catch {
      return null;
    }
  }

  async listInvoices(customerId: string): Promise<ProviderInvoice[]> {
    const out: ProviderInvoice[] = [];
    for await (const inv of this.stripe.invoices.list({
      customer: customerId,
      limit: 100,
    })) {
      if (inv.status === "draft") continue;
      out.push(await this.mapInvoice(inv));
    }
    return out;
  }

  async getInvoiceDocument(invoiceId: string): Promise<InvoiceDocument> {
    const inv = await this.stripe.invoices.retrieve(invoiceId);
    const url = inv.invoice_pdf ?? inv.hosted_invoice_url;
    if (!url) throw new Error(`invoice ${invoiceId} has no document yet`);
    return { kind: "redirect", url };
  }

  // ── customer portal (card updates) ────────────────────────────────────

  async createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const configuration = String(
      this.config.get("STRIPE_PORTAL_CONFIGURATION", "") ?? "",
    );
    const s = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
      ...(configuration && !configuration.includes("PLACEHOLDER")
        ? { configuration }
        : {}),
    });
    return { url: s.url };
  }

  // ── promotions (a mirror for the dashboard; our engine validates, checkout applies coupons) ──

  async syncPromotion(promo: PromoMirror): Promise<Record<string, string>> {
    const coupon = await this.couponFor(
      {
        source: "promo",
        code: promo.code,
        percentOff: promo.percentOff,
        amountOff: promo.amountOff,
        duration: promo.duration,
        durationInMonths: promo.durationInMonths,
      },
      promo.currency,
    );
    const pc = await this.stripe.promotionCodes.create(
      {
        promotion: { type: "coupon", coupon },
        code: promo.code,
        ...(promo.maxRedemptions
          ? { max_redemptions: promo.maxRedemptions }
          : {}),
        ...(promo.expiresAt
          ? { expires_at: Math.floor(Date.parse(promo.expiresAt) / 1000) }
          : {}),
        ...(promo.firstTimeOnly
          ? { restrictions: { first_time_transaction: true } }
          : {}),
        metadata: { promoId: promo.id },
      } as unknown as Stripe.PromotionCodeCreateParams,
      { idempotencyKey: `promo-${promo.id}` },
    );
    return { stripeCouponId: coupon, stripePromotionCodeId: pc.id };
  }

  async deactivatePromotion(promo: PromoMirror): Promise<void> {
    const id = promo.providerRefs?.stripePromotionCodeId;
    if (id) await this.stripe.promotionCodes.update(id, { active: false });
  }

  // ── events ────────────────────────────────────────────────────────────

  async parseEvent(
    rawBody: Buffer | string,
    signature: string | undefined,
  ): Promise<ProviderEvent | null> {
    const secret = String(this.config.get("STRIPE_WEBHOOK_SECRET", "") ?? "");
    let e: Stripe.Event;
    try {
      if (!signature || !secret || secret.includes("PLACEHOLDER"))
        throw new Error("missing signature or webhook secret");
      e = this.stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      throw new InvalidEventSignatureError((err as Error).message);
    }
    let type = STRIPE_EVENT_MAP[e.type];
    if (!type) return null;
    // A test-mode event never changes live state, and vice versa.
    if (e.livemode !== this.livemode) return null;
    const obj = e.data.object as unknown as Record<string, unknown> & {
      id: string;
      object: string;
      metadata?: Record<string, string>;
    };
    const base = {
      id: e.id,
      created: e.created * 1000,
      provider: "stripe" as const,
    };
    if (obj.object === "subscription") {
      return {
        ...base,
        type,
        data: {
          uid: obj.metadata?.uid ?? null,
          customerId: idOf(obj.customer as string),
          subscriptionId: obj.id,
        },
      };
    }
    if (obj.object === "setup_intent") {
      const si = obj as unknown as Stripe.SetupIntent;
      // Only our free-trial card setups (they carry the plan in metadata).
      if (!si.metadata?.planId) return null;
      return {
        ...base,
        type,
        data: {
          uid: si.metadata.uid ?? null,
          customerId: idOf(si.customer),
          subscriptionId: null,
          invoiceId: null,
          checkoutSessionId: si.id,
          amount: 0,
        },
      };
    }
    if (obj.object === "invoice") {
      const inv = obj as unknown as Stripe.Invoice;
      const sd = inv.parent?.subscription_details;
      const subscriptionId = idOf(
        sd?.subscription as string | Stripe.Subscription | undefined,
      );
      const first = inv.billing_reason === "subscription_create";
      // The buyer is still on the checkout page: Stripe shows the decline / 3-D Secure there.
      if (
        first &&
        (type === "invoice.payment_failed" ||
          type === "invoice.action_required")
      )
        return null;
      if (first && type === "invoice.paid") type = "checkout.completed";
      return {
        ...base,
        type,
        data: {
          uid: sd?.metadata?.uid ?? null,
          customerId: idOf(inv.customer),
          subscriptionId,
          invoiceId: inv.id ?? null,
          checkoutSessionId: first
            ? (sd?.metadata?.setupIntentId ?? subscriptionId)
            : null,
          amount:
            type === "invoice.upcoming" ? inv.amount_due : inv.amount_paid,
        },
      };
    }
    if (obj.object === "charge" || obj.object === "dispute") {
      const pi = idOf((obj.payment_intent ?? null) as string | null);
      let invoiceId: string | null = null;
      if (pi) {
        const pays = await this.stripe.invoicePayments.list({
          payment: { type: "payment_intent", payment_intent: pi },
          limit: 1,
        });
        invoiceId = idOf(
          pays.data[0]?.invoice as string | Stripe.Invoice | undefined,
        );
      }
      if (!invoiceId) return null;
      return {
        ...base,
        type,
        data: {
          customerId: idOf(obj.customer as string),
          invoiceId,
          amount: Number(obj.amount_refunded ?? obj.amount ?? 0),
        },
      };
    }
    if (obj.object === "checkout.session") {
      return {
        ...base,
        type,
        data: {
          uid: obj.metadata?.uid ?? (obj.client_reference_id as string) ?? null,
          customerId: idOf(obj.customer as string),
          subscriptionId: idOf(obj.subscription as string),
          checkoutSessionId: obj.id,
        },
      };
    }
    this.logger.warn(`unhandled Stripe object ${obj.object} for ${e.type}`);
    return null;
  }
}
