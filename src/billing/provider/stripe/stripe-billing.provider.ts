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
 *   STRIPE_PAYMENT_METHOD_TYPES   default "card,link" (Apple Pay / Google Pay ride on card);
 *                                 add ",paypal" only if the account supports it — never crypto/UPI.
 *                                 Must match NEXT_PUBLIC_STRIPE_PAYMENT_METHOD_TYPES in the UI.
 */
export const STRIPE_API_VERSION = "2025-08-27.basil" as const;

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
/** Register exactly these on the webhook endpoint. */
export const STRIPE_WEBHOOK_EVENTS = Object.keys(STRIPE_EVENT_MAP);

const ALLOWED_PAYMENT_METHODS = new Set([
  "card",
  "link",
  "paypal",
  "us_bank_account",
  "cashapp",
  "amazon_pay",
]);
const lineOf = (l: Stripe.InvoiceLineItem): InvoiceLine => ({
  description: l.description ?? "",
  amount: l.amount,
  proration:
    (
      l as unknown as {
        parent?: { subscription_item_details?: { proration?: boolean } };
      }
    ).parent?.subscription_item_details?.proration ?? false,
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
      this.config.get("STRIPE_PAYMENT_METHOD_TYPES", "card,link") ??
        "card,link",
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

  async updateCustomerContact(
    customerId: string,
    contact: { phone: string },
  ): Promise<void> {
    await this.stripe.customers.update(customerId, { phone: contact.phone });
  }

  // ── checkout ──────────────────────────────────────────────────────────

  async previewCheckout(input: {
    price: PriceRef;
    discount: AppliedDiscount | null;
    region: BillingRegion | null;
  }): Promise<CheckoutQuote> {
    const price = await this.priceId(input.price.lookupKey);
    const coupon = input.discount
      ? await this.couponFor(input.discount, input.price.currency)
      : null;
    const inv = await this.stripe.invoices.createPreview({
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
    const tax = sumAmounts(inv.total_taxes);
    return {
      currency: inv.currency.toUpperCase(),
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
  }): Promise<CheckoutSession> {
    if (input.billing) {
      // The full address stays at Stripe (it is also what Stripe Tax uses).
      const a = input.billing.address;
      await this.stripe.customers.update(input.customerId, {
        name: input.billing.name,
        phone: input.billing.phone,
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
    const price = await this.priceId(input.price.lookupKey);
    const coupon = input.discount
      ? await this.couponFor(input.discount, input.price.currency)
      : null;
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
        ...(coupon ? { discounts: [{ coupon }] } : {}),
        metadata: {
          uid: input.uid,
          planId: input.price.planId,
          interval: input.price.interval,
        },
        expand: ["latest_invoice.confirmation_secret"],
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
      amountDueToday: inv
        ? status === "complete"
          ? inv.amount_paid
          : inv.amount_due
        : 0,
      tax: inv ? sumAmounts(inv.total_taxes) : 0,
      currency: (inv?.currency ?? item?.price?.currency ?? "usd").toUpperCase(),
      expiresAt: iso(sub.created + 23 * 3600) ?? new Date().toISOString(),
      subscriptionId: sub.id,
      successUrl: successUrl.replace("{CHECKOUT_SESSION_ID}", sub.id),
      cancelUrl,
      clientSecret: inv?.confirmation_secret?.client_secret ?? null,
    };
  }

  async getCheckout(sessionId: string): Promise<CheckoutSession | null> {
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

  /** Upgrades charge now; a change of interval restarts the billing period (anchor now). */
  private changeParams(
    sub: Stripe.Subscription,
    target: PriceRef,
    priceId: string,
    prorationDate: number,
  ) {
    const item = sub.items.data[0];
    const intervalChange =
      CATALOG.get(item.price.lookup_key ?? "")?.interval !== target.interval;
    return {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: "always_invoice" as const,
      proration_date: Math.floor(prorationDate / 1000),
      ...(intervalChange ? { billing_cycle_anchor: "now" as const } : {}),
    };
  }

  async previewChange(input: {
    subscriptionId: string;
    target: PriceRef;
    kind: "upgrade" | "downgrade";
  }): Promise<ChangePreview> {
    const sub = await this.retrieveSub(input.subscriptionId);
    const current = await this.mapSubscription(sub);
    const prorationDate = Date.now();
    if (input.kind === "downgrade") {
      return {
        kind: "downgrade",
        planId: input.target.planId,
        interval: input.target.interval,
        currency: input.target.currency,
        amountDueNow: 0,
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
    return {
      kind: "upgrade",
      planId: input.target.planId,
      interval: input.target.interval,
      currency: inv.currency.toUpperCase(),
      amountDueNow: inv.amount_due,
      prorationDate,
      effectiveAt: new Date(prorationDate).toISOString(),
      nextRenewalAmount: input.target.amount,
      nextRenewalDate: iso(nextEnd) ?? current.currentPeriodEnd,
      lines,
    };
  }

  async changePlan(input: {
    subscriptionId: string;
    target: PriceRef;
    kind: "upgrade" | "downgrade";
    prorationDate: number;
    expectedAmountDue: number | null;
  }): Promise<ChangeResult> {
    const sub = await this.retrieveSub(input.subscriptionId);
    const priceId = await this.priceId(input.target.lookupKey);
    const scheduleId = idOf(
      sub.schedule as string | Stripe.SubscriptionSchedule | null,
    );
    if (input.kind === "downgrade") {
      // Keep the current plan to period end, then the new price (and metadata) via a schedule.
      const item = sub.items.data[0];
      const schedId =
        scheduleId ??
        (
          await this.stripe.subscriptionSchedules.create({
            from_subscription: sub.id,
          })
        ).id;
      await this.stripe.subscriptionSchedules.update(schedId, {
        end_behavior: "release",
        phases: [
          {
            items: [{ price: item.price.id }],
            start_date: item.current_period_start,
            end_date: item.current_period_end,
            metadata: { ...sub.metadata },
          },
          {
            items: [{ price: priceId }],
            metadata: {
              ...sub.metadata,
              planId: input.target.planId,
              interval: input.target.interval,
            },
            proration_behavior: "none",
          },
        ],
      });
      return {
        status: "scheduled",
        effectiveAt: iso(item.current_period_end)!,
      };
    }
    if (input.expectedAmountDue != null) {
      const fresh = await this.previewChange({
        subscriptionId: sub.id,
        target: input.target,
        kind: "upgrade",
      });
      if (Math.abs(fresh.amountDueNow - input.expectedAmountDue) > 1)
        throw new PreviewStaleError(
          input.expectedAmountDue,
          fresh.amountDueNow,
        );
    }
    // An upgrade drops a pending downgrade and resumes a cancelling plan.
    if (scheduleId) await this.stripe.subscriptionSchedules.release(scheduleId);
    const p = this.changeParams(
      sub,
      input.target,
      priceId,
      input.prorationDate,
    );
    const updated = await this.stripe.subscriptions.update(sub.id, {
      ...p,
      cancel_at_period_end: false,
      payment_behavior: "pending_if_incomplete",
      metadata: {
        ...sub.metadata,
        planId: input.target.planId,
        interval: input.target.interval,
      },
      expand: ["latest_invoice.confirmation_secret"],
    });
    const inv =
      typeof updated.latest_invoice === "object"
        ? updated.latest_invoice
        : null;
    if (!updated.pending_update) {
      return {
        status: "applied",
        invoiceId: inv?.id ?? null,
        amountCharged: inv?.amount_paid ?? 0,
        effectiveAt: new Date().toISOString(),
      };
    }
    const secret = inv?.confirmation_secret?.client_secret ?? null;
    if (inv && secret)
      return {
        status: "requires_action",
        actionId: inv.id ?? "",
        clientSecret: secret,
        amountDue: inv.amount_due,
      };
    return { status: "payment_failed", reason: "card_declined" };
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

  // ── refunds ───────────────────────────────────────────────────────────

  /** Refunds the invoice's payment, then ends the subscription now (→ Free via subscription.deleted). */
  async refund(paymentId: string, amount: number): Promise<void> {
    const pays = await this.stripe.invoicePayments.list({
      invoice: paymentId,
      status: "paid",
      limit: 10,
    });
    const pi =
      pays.data
        .map((p) =>
          idOf(
            p.payment?.payment_intent as
              string | Stripe.PaymentIntent | undefined,
          ),
        )
        .find(Boolean) ?? null;
    const charge =
      pays.data
        .map((p) =>
          idOf(p.payment?.charge as string | Stripe.Charge | undefined),
        )
        .find(Boolean) ?? null;
    if (!pi && !charge)
      throw new Error(`invoice ${paymentId} has no captured payment to refund`);
    await this.stripe.refunds.create(
      {
        ...(pi ? { payment_intent: pi } : { charge: charge! }),
        amount,
        reason: "requested_by_customer",
        metadata: { invoice: paymentId, reason: "refund_policy" },
      },
      { idempotencyKey: `refund-${paymentId}` },
    );
    // Record the refunded amount on the invoice so getInvoice reports it.
    await this.stripe.invoices.update(paymentId, {
      metadata: { amount_refunded: String(amount) },
    });
    const inv = await this.stripe.invoices.retrieve(paymentId);
    const subId = idOf(
      inv.parent?.subscription_details?.subscription as
        string | Stripe.Subscription | undefined,
    );
    if (!subId) return;
    const sub = await this.stripe.subscriptions.retrieve(subId);
    const s = idOf(sub.schedule as string | Stripe.SubscriptionSchedule | null);
    if (s) await this.stripe.subscriptionSchedules.release(s);
    if (!sub.ended_at)
      await this.stripe.subscriptions.cancel(subId, {
        prorate: false,
        invoice_now: false,
      });
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
          checkoutSessionId: first ? subscriptionId : null,
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
