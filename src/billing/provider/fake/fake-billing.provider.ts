import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Logger } from "@nestjs/common";
import type { AppClock } from "../../../common/app-clock";
import type { FirebaseAdminService } from "../../../common/firebase-admin.provider";
import type { BillingInterval } from "../../../plans/plans.registry";
import {
  InvalidEventSignatureError,
  PaymentDeclinedError,
  PreviewStaleError,
  type BillingProvider,
} from "../billing-provider";
import type {
  AppliedDiscount,
  ChangePreview,
  ChangeResult,
  CheckoutSession,
  InvoiceDocument,
  InvoiceLine,
  PriceRef,
  PromoMirror,
  ProviderEvent,
  ProviderEventType,
  ProviderInvoice,
  ProviderSubscription,
  RetentionDiscountInput,
} from "../types";

/**
 * FakeBillingProvider — a complete payment-provider simulator for development,
 * staging and tests. NEVER used in production (provider.factory.ts refuses to
 * start with it in the production project).
 *
 * State lives in backend-only Firestore collections (fake_billing_*). It
 * models what the app relies on from Stripe: hosted checkout that succeeds or
 * fails by test card, invoices with discounts / proration / customer credit,
 * period dates and renewals, failed-payment retries, scheduled downgrades,
 * period-end cancellation, renewal reminders — and it reports every change
 * as a signed event delivered to the same handler the Stripe webhook uses.
 *
 * Time comes from AppClock; advanceTo() moves it forward and processes
 * everything that falls due on the way, in order.
 */

/** Test-card behaviours (Stripe test numbers in brackets). */
export type FakeCardBehavior =
  | "success" // 4242 4242 4242 4242
  | "decline" // 4000 0000 0000 0002
  | "insufficient_funds" // 4000 0000 0000 9995
  | "requires_3ds" // 4000 0025 0000 3155
  | "renewal_failure"; // 4000 0000 0000 0341: first charge ok, later charges fail

export const FAKE_TEST_CARDS: Record<string, FakeCardBehavior> = {
  "4242424242424242": "success",
  "4000000000000002": "decline",
  "4000000000009995": "insufficient_funds",
  "4000002500003155": "requires_3ds",
  "4000000000000341": "renewal_failure",
};

/** Days after the failed renewal on which payment is retried; the last failure ends the subscription. */
export const FAKE_RETRY_DAYS = [1, 3, 5, 7];
/** Days before renewal on which invoice.upcoming fires. */
export const FAKE_UPCOMING_DAYS = 7;
/** Hosted checkout sessions expire after this long. */
export const FAKE_CHECKOUT_TTL_MS = 24 * 3600_000;

const DAY = 86_400_000;
const C = {
  customers: "fake_billing_customers",
  subscriptions: "fake_billing_subscriptions",
  invoices: "fake_billing_invoices",
  checkouts: "fake_billing_checkouts",
  actions: "fake_billing_actions",
  events: "fake_billing_events",
  portal: "fake_billing_portal_sessions",
  promotions: "fake_billing_promotions",
};

interface FakeCustomer {
  id: string;
  uid: string;
  email: string | null;
  card: FakeCardBehavior | null;
  successfulCharges: number;
  /** Credit owed to the customer, minor units (>= 0). */
  creditBalance: number;
  metadata: Record<string, string>;
  createdAt: string;
}

interface FakeAction {
  id: string;
  kind: "checkout" | "change";
  status: "pending" | "done" | "failed";
  checkoutId?: string;
  subscriptionId?: string;
  target?: PriceRef;
  prorationDate?: number;
  amountDue?: number;
}

type ChargeOutcome =
  { ok: true } | { ok: false; code: string } | { ok: "action" };

export type EventSink = (rawBody: string, signature: string) => Promise<void>;

export interface CheckoutCompletion {
  status: "complete" | "requires_action" | "failed";
  code?: string;
  actionId?: string;
  subscriptionId?: string;
  redirectUrl?: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ms(isoStr: string): number {
  return Date.parse(isoStr);
}

/** Calendar addition in UTC; month ends clamp (31 Jan + 1 month = 28/29 Feb). */
export function addInterval(
  fromMs: number,
  interval: BillingInterval,
  count = 1,
): number {
  const d = new Date(fromMs);
  const months = interval === "annual" ? 12 * count : count;
  const target = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + months,
      1,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target.getTime();
}

/** Discount amount for a subtotal; never more than the subtotal. */
export function discountAmountFor(
  discount: AppliedDiscount | null,
  subtotal: number,
): number {
  if (!discount || subtotal <= 0) return 0;
  if (discount.remainingInvoices != null && discount.remainingInvoices <= 0)
    return 0;
  const raw =
    discount.percentOff != null
      ? Math.round((subtotal * discount.percentOff) / 100)
      : (discount.amountOff ?? 0);
  return Math.min(subtotal, Math.max(0, raw));
}

/** The discount after one invoice has used it (null when used up). */
export function consumeDiscount(
  discount: AppliedDiscount | null,
): AppliedDiscount | null {
  if (!discount) return null;
  if (discount.remainingInvoices == null) return discount; // forever
  const left = discount.remainingInvoices - 1;
  return left > 0 ? { ...discount, remainingInvoices: left } : null;
}

/** Turns a promo/retention discount definition into its per-invoice form for an interval. */
export function normaliseDiscount(
  d: AppliedDiscount,
  interval: BillingInterval,
  fromMs: number,
): AppliedDiscount {
  let remaining: number | null;
  if (d.remainingInvoices !== undefined && d.remainingInvoices !== null)
    remaining = d.remainingInvoices;
  else if (d.duration === "forever") remaining = null;
  else if (d.duration === "once") remaining = 1;
  else {
    const months = Math.max(1, d.durationInMonths ?? 1);
    remaining = interval === "monthly" ? months : Math.ceil(months / 12);
  }
  const endsAt =
    remaining == null ? null : iso(addInterval(fromMs, interval, remaining));
  return { ...d, remainingInvoices: remaining, endsAt };
}

export class FakeBillingProvider implements BillingProvider {
  readonly name = "fake" as const;
  private readonly logger = new Logger("FakeBillingProvider");
  private sink: EventSink | null = null;
  private readonly secret: string;

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly clock: AppClock,
    private readonly opts: { appUrl: string; webhookSecret?: string },
  ) {
    this.secret = opts.webhookSecret || randomBytes(32).toString("hex");
    this.clock.enableControl();
  }

  // ── plumbing ──────────────────────────────────────────────────────────

  private get db() {
    return this.firebase.firestore;
  }

  private id(prefix: string): string {
    return `${prefix}_${randomBytes(9).toString("hex")}`;
  }

  private async read<T>(col: string, id: string): Promise<T | null> {
    const snap = await this.db.collection(col).doc(id).get();
    return snap.exists ? (snap.data() as T) : null;
  }

  private async write<T extends { id: string }>(
    col: string,
    obj: T,
  ): Promise<void> {
    await this.db
      .collection(col)
      .doc(obj.id)
      .set(JSON.parse(JSON.stringify(obj)) as Record<string, unknown>);
  }

  private async all<T>(col: string): Promise<T[]> {
    const snap = await this.db.collection(col).get();
    return snap.docs.map((d) => d.data() as T);
  }

  /** Where events go — BillingEventsService registers itself on startup. */
  setEventSink(sink: EventSink): void {
    this.sink = sink;
  }

  /** HMAC signature in Stripe's header shape: t=<ms>,v1=<hex>. */
  sign(rawBody: string, at = this.clock.now()): string {
    const v1 = createHmac("sha256", this.secret)
      .update(`${at}.${rawBody}`)
      .digest("hex");
    return `t=${at},v1=${v1}`;
  }

  parseEvent(
    rawBody: Buffer | string,
    signature: string | undefined,
  ): ProviderEvent {
    const body =
      typeof rawBody === "string" ? rawBody : rawBody?.toString("utf8");
    if (!body || !signature)
      throw new InvalidEventSignatureError("missing body or signature");
    const parts = Object.fromEntries(
      signature.split(",").map((p) => p.split("=", 2) as [string, string]),
    );
    if (!parts.t || !parts.v1)
      throw new InvalidEventSignatureError("malformed signature header");
    const expected = createHmac("sha256", this.secret)
      .update(`${parts.t}.${body}`)
      .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.v1);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new InvalidEventSignatureError("signature mismatch");
    try {
      return JSON.parse(body) as ProviderEvent;
    } catch {
      throw new InvalidEventSignatureError("unparseable body");
    }
  }

  private async emit(
    type: ProviderEventType,
    data: ProviderEvent["data"],
  ): Promise<ProviderEvent> {
    const event: ProviderEvent = {
      id: this.id("evt"),
      type,
      created: this.clock.now(),
      provider: "fake",
      data,
    };
    await this.db
      .collection(C.events)
      .doc(event.id)
      .set(JSON.parse(JSON.stringify(event)) as Record<string, unknown>);
    await this.deliver(event);
    return event;
  }

  private async deliver(event: ProviderEvent): Promise<void> {
    if (!this.sink) {
      this.logger.warn(
        `no event sink registered; ${event.type} ${event.id} stored only`,
      );
      return;
    }
    const raw = JSON.stringify(event);
    await this.sink(raw, this.sign(raw));
  }

  /** Re-sends a stored event (tests for duplicate delivery). */
  async redeliver(eventId: string): Promise<void> {
    const e = await this.read<ProviderEvent>(C.events, eventId);
    if (!e) throw new Error(`no such event ${eventId}`);
    await this.deliver(e);
  }

  async listEvents(): Promise<ProviderEvent[]> {
    return (await this.all<ProviderEvent>(C.events)).sort(
      (a, b) => a.created - b.created,
    );
  }

  // ── customers ─────────────────────────────────────────────────────────

  async createCustomer(input: {
    uid: string;
    email: string | null;
  }): Promise<{ customerId: string }> {
    const c: FakeCustomer = {
      id: this.id("cus"),
      uid: input.uid,
      email: input.email,
      card: null,
      successfulCharges: 0,
      creditBalance: 0,
      metadata: {},
      createdAt: this.clock.nowIso(),
    };
    await this.write(C.customers, c);
    return { customerId: c.id };
  }

  async setCustomerMetadata(
    customerId: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    const c = await this.mustCustomer(customerId);
    c.metadata = { ...c.metadata, ...metadata };
    await this.write(C.customers, c);
  }

  async getCustomer(customerId: string): Promise<FakeCustomer | null> {
    return this.read<FakeCustomer>(C.customers, customerId);
  }

  private async mustCustomer(id: string): Promise<FakeCustomer> {
    const c = await this.read<FakeCustomer>(C.customers, id);
    if (!c) throw new Error(`no such customer ${id}`);
    return c;
  }

  private charge(c: FakeCustomer, onSession: boolean): ChargeOutcome {
    switch (c.card) {
      case "success":
        return { ok: true };
      case "decline":
        return { ok: false, code: "card_declined" };
      case "insufficient_funds":
        return { ok: false, code: "insufficient_funds" };
      case "requires_3ds":
        return onSession
          ? { ok: "action" }
          : { ok: false, code: "authentication_required" };
      case "renewal_failure":
        return c.successfulCharges === 0
          ? { ok: true }
          : { ok: false, code: "card_declined" };
      default:
        return { ok: false, code: "no_payment_method" };
    }
  }

  // ── checkout ──────────────────────────────────────────────────────────

  async createCheckout(input: {
    uid: string;
    customerId: string;
    price: PriceRef;
    discount: AppliedDiscount | null;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CheckoutSession> {
    // Idempotent: the same key returns the same open session.
    const existing = (
      await this.all<CheckoutSession & { idempotencyKey: string }>(C.checkouts)
    ).find(
      (s) => s.idempotencyKey === input.idempotencyKey && s.status === "open",
    );
    if (existing) return existing;
    const now = this.clock.now();
    const discount = input.discount
      ? normaliseDiscount(input.discount, input.price.interval, now)
      : null;
    const id = this.id("cs");
    const session: CheckoutSession & {
      idempotencyKey: string;
      lookupKey: string;
      amount: number;
    } = {
      id,
      url: `${this.opts.appUrl}/billing/checkout?session=${id}`,
      status: "open",
      uid: input.uid,
      customerId: input.customerId,
      planId: input.price.planId,
      interval: input.price.interval,
      discount,
      amountDueToday:
        input.price.amount - discountAmountFor(discount, input.price.amount),
      currency: input.price.currency,
      expiresAt: iso(now + FAKE_CHECKOUT_TTL_MS),
      subscriptionId: null,
      successUrl: input.successUrl.replace("{CHECKOUT_SESSION_ID}", id),
      cancelUrl: input.cancelUrl,
      idempotencyKey: input.idempotencyKey,
      lookupKey: input.price.lookupKey,
      amount: input.price.amount,
    };
    await this.write(C.checkouts, session);
    return session;
  }

  async getCheckout(sessionId: string): Promise<CheckoutSession | null> {
    return this.read<CheckoutSession>(C.checkouts, sessionId);
  }

  /** The hosted checkout page's "Pay" button. */
  async completeCheckout(
    sessionId: string,
    card: FakeCardBehavior,
  ): Promise<CheckoutCompletion> {
    const s = await this.read<
      CheckoutSession & { lookupKey: string; amount: number }
    >(C.checkouts, sessionId);
    if (!s) throw new Error(`no such checkout ${sessionId}`);
    if (s.status !== "open")
      return { status: "failed", code: `session_${s.status}` };
    if (ms(s.expiresAt) <= this.clock.now()) {
      await this.expireCheckout(s);
      return { status: "failed", code: "session_expired" };
    }
    const c = await this.mustCustomer(s.customerId);
    c.card = card;
    await this.write(C.customers, c);
    const outcome = this.charge(c, true);
    if (outcome.ok === "action") {
      const action: FakeAction = {
        id: this.id("act"),
        kind: "checkout",
        status: "pending",
        checkoutId: s.id,
      };
      await this.write(C.actions, action);
      return { status: "requires_action", actionId: action.id };
    }
    if (outcome.ok === false) return { status: "failed", code: outcome.code };
    const subId = await this.finaliseCheckout(s, c);
    return {
      status: "complete",
      subscriptionId: subId,
      redirectUrl: s.successUrl,
    };
  }

  private async finaliseCheckout(
    s: CheckoutSession & { lookupKey: string; amount: number },
    c: FakeCustomer,
  ): Promise<string> {
    const now = this.clock.now();
    const end = addInterval(now, s.interval);
    const subtotal = s.amount;
    const discountAmount = discountAmountFor(s.discount, subtotal);
    const sub: ProviderSubscription = {
      id: this.id("sub"),
      customerId: c.id,
      uid: s.uid,
      planId: s.planId,
      interval: s.interval,
      priceLookupKey: s.lookupKey,
      amount: s.amount,
      currency: s.currency,
      status: "active",
      startedAt: iso(now),
      currentPeriodStart: iso(now),
      currentPeriodEnd: iso(end),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      endedAt: null,
      discount: consumeDiscount(s.discount),
      scheduledChange: null,
      pastDueSince: null,
      latestInvoiceId: null,
      updatedAt: now,
    };
    const lines: InvoiceLine[] = [
      {
        description: `${s.planId} (${s.interval})`,
        amount: subtotal,
        proration: false,
      },
    ];
    const inv = this.newInvoice(sub, {
      billingReason: "subscription_create",
      periodStart: now,
      periodEnd: end,
      subtotal,
      discountAmount,
      creditApplied: 0,
      lines,
      discount: s.discount,
    });
    this.markPaid(inv);
    c.successfulCharges++;
    sub.latestInvoiceId = inv.id;
    await this.write(C.customers, c);
    await this.write(C.invoices, inv);
    await this.write(C.subscriptions, sub);
    s.status = "complete";
    s.subscriptionId = sub.id;
    await this.write(C.checkouts, s);
    await this.emit("checkout.completed", {
      uid: s.uid,
      customerId: c.id,
      checkoutSessionId: s.id,
      subscriptionId: sub.id,
    });
    await this.emit("subscription.created", {
      uid: s.uid,
      customerId: c.id,
      subscriptionId: sub.id,
    });
    await this.emit("invoice.paid", {
      uid: s.uid,
      customerId: c.id,
      subscriptionId: sub.id,
      invoiceId: inv.id,
      amount: inv.amountPaid,
    });
    return sub.id;
  }

  private async expireCheckout(s: CheckoutSession): Promise<void> {
    s.status = "expired";
    await this.write(C.checkouts, s);
    await this.emit("checkout.expired", {
      uid: s.uid,
      customerId: s.customerId,
      checkoutSessionId: s.id,
    });
  }

  /** 3-D Secure challenge: approve or fail. */
  async confirmAction(
    actionId: string,
    approve: boolean,
  ): Promise<{
    status: "complete" | "failed";
    redirectUrl?: string;
    code?: string;
  }> {
    const a = await this.read<FakeAction>(C.actions, actionId);
    if (!a || a.status !== "pending")
      return { status: "failed", code: "no_pending_action" };
    if (!approve) {
      a.status = "failed";
      await this.write(C.actions, a);
      return { status: "failed", code: "authentication_failed" };
    }
    a.status = "done";
    await this.write(C.actions, a);
    if (a.kind === "checkout") {
      const s = await this.read<
        CheckoutSession & { lookupKey: string; amount: number }
      >(C.checkouts, a.checkoutId);
      const c = await this.mustCustomer(s.customerId);
      await this.finaliseCheckout(s, c);
      return { status: "complete", redirectUrl: s.successUrl };
    }
    const sub = await this.mustSubscription(a.subscriptionId);
    await this.applyUpgrade(sub, a.target, a.prorationDate);
    return { status: "complete" };
  }

  // ── subscriptions ─────────────────────────────────────────────────────

  async getSubscription(
    subscriptionId: string,
  ): Promise<ProviderSubscription | null> {
    return this.read<ProviderSubscription>(C.subscriptions, subscriptionId);
  }

  private async mustSubscription(id: string): Promise<ProviderSubscription> {
    const s = await this.getSubscription(id);
    if (!s) throw new Error(`no such subscription ${id}`);
    return s;
  }

  async listSubscriptions(): Promise<ProviderSubscription[]> {
    return (await this.all<ProviderSubscription>(C.subscriptions)).filter(
      (s) => !s.endedAt,
    );
  }

  /** Tests/reconcile: every subscription, ended or not. */
  async listAllSubscriptions(): Promise<ProviderSubscription[]> {
    return this.all<ProviderSubscription>(C.subscriptions);
  }

  private prorate(sub: ProviderSubscription, target: PriceRef, at: number) {
    const start = ms(sub.currentPeriodStart);
    const end = ms(sub.currentPeriodEnd);
    const remaining = Math.min(
      1,
      Math.max(0, (end - at) / Math.max(1, end - start)),
    );
    const unused = Math.round(sub.amount * remaining);
    const lines: InvoiceLine[] = [
      {
        description: `Unused time on ${sub.planId} (${sub.interval})`,
        amount: -unused,
        proration: true,
      },
    ];
    let amountDue: number;
    let periodStart = start;
    let periodEnd = end;
    if (target.interval === sub.interval) {
      const charge = Math.round(target.amount * remaining);
      lines.push({
        description: `Remaining time on ${target.planId} (${target.interval})`,
        amount: charge,
        proration: true,
      });
      amountDue = charge - unused;
    } else {
      // Interval change resets the billing cycle: new full period from now.
      lines.push({
        description: `${target.planId} (${target.interval})`,
        amount: target.amount,
        proration: false,
      });
      amountDue = target.amount - unused;
      periodStart = at;
      periodEnd = addInterval(at, target.interval);
    }
    return { amountDue: Math.max(0, amountDue), lines, periodStart, periodEnd };
  }

  async previewChange(input: {
    subscriptionId: string;
    target: PriceRef;
    kind: "upgrade" | "downgrade";
  }): Promise<ChangePreview> {
    const sub = await this.mustSubscription(input.subscriptionId);
    const at = this.clock.now();
    if (input.kind === "downgrade") {
      return {
        kind: "downgrade",
        planId: input.target.planId,
        interval: input.target.interval,
        currency: input.target.currency,
        amountDueNow: 0,
        prorationDate: at,
        effectiveAt: sub.currentPeriodEnd,
        nextRenewalAmount: input.target.amount,
        nextRenewalDate: sub.currentPeriodEnd,
        lines: [],
      };
    }
    const p = this.prorate(sub, input.target, at);
    return {
      kind: "upgrade",
      planId: input.target.planId,
      interval: input.target.interval,
      currency: input.target.currency,
      amountDueNow: p.amountDue,
      prorationDate: at,
      effectiveAt: iso(at),
      nextRenewalAmount: input.target.amount,
      nextRenewalDate: iso(p.periodEnd),
      lines: p.lines,
    };
  }

  async changePlan(input: {
    subscriptionId: string;
    target: PriceRef;
    kind: "upgrade" | "downgrade";
    prorationDate: number;
    expectedAmountDue: number | null;
  }): Promise<ChangeResult> {
    const sub = await this.mustSubscription(input.subscriptionId);
    if (input.kind === "downgrade") {
      sub.scheduledChange = {
        planId: input.target.planId,
        interval: input.target.interval,
        effectiveAt: sub.currentPeriodEnd,
      };
      (
        sub as ProviderSubscription & { scheduledTarget?: PriceRef }
      ).scheduledTarget = input.target;
      sub.updatedAt = this.clock.now();
      await this.write(C.subscriptions, sub);
      await this.emit("subscription.updated", {
        uid: sub.uid,
        customerId: sub.customerId,
        subscriptionId: sub.id,
      });
      return { status: "scheduled", effectiveAt: sub.currentPeriodEnd };
    }
    const at = input.prorationDate ?? this.clock.now();
    const p = this.prorate(sub, input.target, at);
    if (
      input.expectedAmountDue != null &&
      input.expectedAmountDue !== p.amountDue
    ) {
      throw new PreviewStaleError(input.expectedAmountDue, p.amountDue);
    }
    if (p.amountDue > 0) {
      const c = await this.mustCustomer(sub.customerId);
      const outcome = this.charge(c, true);
      if (outcome.ok === "action") {
        const action: FakeAction = {
          id: this.id("act"),
          kind: "change",
          status: "pending",
          subscriptionId: sub.id,
          target: input.target,
          prorationDate: at,
          amountDue: p.amountDue,
        };
        await this.write(C.actions, action);
        return {
          status: "requires_action",
          actionId: action.id,
          clientSecret: null,
          amountDue: p.amountDue,
        };
      }
      if (outcome.ok === false)
        return { status: "payment_failed", reason: outcome.code };
    }
    const invoiceId = await this.applyUpgrade(sub, input.target, at);
    return {
      status: "applied",
      invoiceId,
      amountCharged: p.amountDue,
      effectiveAt: iso(at),
    };
  }

  private async applyUpgrade(
    sub: ProviderSubscription,
    target: PriceRef,
    at: number,
  ): Promise<string | null> {
    const p = this.prorate(sub, target, at);
    sub.planId = target.planId;
    sub.interval = target.interval;
    sub.amount = target.amount;
    sub.priceLookupKey = target.lookupKey;
    sub.currentPeriodStart = iso(p.periodStart);
    sub.currentPeriodEnd = iso(p.periodEnd);
    sub.scheduledChange = null;
    delete (sub as ProviderSubscription & { scheduledTarget?: PriceRef })
      .scheduledTarget;
    sub.cancelAtPeriodEnd = false;
    sub.updatedAt = this.clock.now();
    let invoiceId: string | null = null;
    if (p.amountDue > 0) {
      const c = await this.mustCustomer(sub.customerId);
      const inv = this.newInvoice(sub, {
        billingReason: "subscription_update",
        periodStart: at,
        periodEnd: p.periodEnd,
        subtotal: p.amountDue,
        discountAmount: 0,
        creditApplied: 0,
        lines: p.lines,
        discount: null,
      });
      this.markPaid(inv);
      c.successfulCharges++;
      await this.write(C.customers, c);
      await this.write(C.invoices, inv);
      sub.latestInvoiceId = inv.id;
      invoiceId = inv.id;
    }
    await this.write(C.subscriptions, sub);
    if (invoiceId) {
      await this.emit("invoice.paid", {
        uid: sub.uid,
        customerId: sub.customerId,
        subscriptionId: sub.id,
        invoiceId,
        amount: p.amountDue,
      });
    }
    await this.emit("subscription.updated", {
      uid: sub.uid,
      customerId: sub.customerId,
      subscriptionId: sub.id,
    });
    return invoiceId;
  }

  async cancelScheduledChange(subscriptionId: string): Promise<void> {
    const sub = await this.mustSubscription(subscriptionId);
    if (!sub.scheduledChange) return;
    sub.scheduledChange = null;
    delete (sub as ProviderSubscription & { scheduledTarget?: PriceRef })
      .scheduledTarget;
    sub.updatedAt = this.clock.now();
    await this.write(C.subscriptions, sub);
    await this.emit("subscription.updated", {
      uid: sub.uid,
      customerId: sub.customerId,
      subscriptionId: sub.id,
    });
  }

  async cancelAtPeriodEnd(subscriptionId: string): Promise<void> {
    const sub = await this.mustSubscription(subscriptionId);
    sub.cancelAtPeriodEnd = true;
    sub.scheduledChange = null; // cancelling wins over a pending downgrade
    delete (sub as ProviderSubscription & { scheduledTarget?: PriceRef })
      .scheduledTarget;
    sub.updatedAt = this.clock.now();
    await this.write(C.subscriptions, sub);
    await this.emit("subscription.updated", {
      uid: sub.uid,
      customerId: sub.customerId,
      subscriptionId: sub.id,
    });
  }

  async resume(subscriptionId: string): Promise<void> {
    const sub = await this.mustSubscription(subscriptionId);
    if (sub.endedAt) throw new Error("subscription has ended");
    sub.cancelAtPeriodEnd = false;
    sub.updatedAt = this.clock.now();
    await this.write(C.subscriptions, sub);
    await this.emit("subscription.updated", {
      uid: sub.uid,
      customerId: sub.customerId,
      subscriptionId: sub.id,
    });
  }

  async applyRetentionDiscount(
    input: RetentionDiscountInput,
  ): Promise<{ description: string; appliesTo: string }> {
    const sub = await this.mustSubscription(input.subscriptionId);
    if (input.mode === "percent_next_invoices") {
      sub.discount = normaliseDiscount(
        {
          source: "retention",
          percentOff: input.percentOff,
          duration: "repeating",
          durationInMonths: input.invoices,
          remainingInvoices: input.invoices,
        },
        sub.interval,
        ms(sub.currentPeriodEnd) - 1,
      );
      sub.cancelAtPeriodEnd = false;
      sub.updatedAt = this.clock.now();
      await this.write(C.subscriptions, sub);
      await this.emit("subscription.updated", {
        uid: sub.uid,
        customerId: sub.customerId,
        subscriptionId: sub.id,
      });
      return {
        description: `${input.percentOff}% off your next ${input.invoices} invoices`,
        appliesTo: sub.currentPeriodEnd,
      };
    }
    const c = await this.mustCustomer(input.customerId);
    c.creditBalance += input.amount;
    await this.write(C.customers, c);
    sub.cancelAtPeriodEnd = false;
    sub.updatedAt = this.clock.now();
    await this.write(C.subscriptions, sub);
    await this.emit("subscription.updated", {
      uid: sub.uid,
      customerId: sub.customerId,
      subscriptionId: sub.id,
    });
    return {
      description: `credit of ${input.amount} applied to your next invoice`,
      appliesTo: sub.currentPeriodEnd,
    };
  }

  // ── invoices ──────────────────────────────────────────────────────────

  private newInvoice(
    sub: ProviderSubscription,
    p: {
      billingReason: ProviderInvoice["billingReason"];
      periodStart: number;
      periodEnd: number;
      subtotal: number;
      discountAmount: number;
      creditApplied: number;
      lines: InvoiceLine[];
      discount: AppliedDiscount | null;
    },
  ): ProviderInvoice {
    const id = this.id("in");
    const total = Math.max(0, p.subtotal - p.discountAmount - p.creditApplied);
    const lines = [...p.lines];
    if (p.discountAmount > 0)
      lines.push({
        description:
          p.discount?.source === "retention"
            ? "Retention discount"
            : `Discount ${p.discount?.code ?? ""}`.trim(),
        amount: -p.discountAmount,
        proration: false,
      });
    if (p.creditApplied > 0)
      lines.push({
        description: "Account credit applied",
        amount: -p.creditApplied,
        proration: false,
      });
    return {
      id,
      number: `FAKE-${id.slice(-6).toUpperCase()}`,
      customerId: sub.customerId,
      subscriptionId: sub.id,
      uid: sub.uid,
      planId: sub.planId,
      interval: sub.interval,
      status: "open",
      billingReason: p.billingReason,
      createdAt: this.clock.nowIso(),
      periodStart: iso(p.periodStart),
      periodEnd: iso(p.periodEnd),
      currency: sub.currency,
      subtotal: p.subtotal,
      discountAmount: p.discountAmount,
      creditApplied: p.creditApplied,
      total,
      amountPaid: 0,
      amountDue: total,
      amountRefunded: 0,
      lines,
      discount: p.discount,
      attemptCount: 0,
      nextPaymentAttempt: null,
      paidAt: null,
      hostedInvoiceUrl: null,
      invoicePdfUrl: null,
    };
  }

  private markPaid(inv: ProviderInvoice): void {
    inv.status = "paid";
    inv.amountPaid = inv.total;
    inv.amountDue = 0;
    inv.paidAt = this.clock.nowIso();
    inv.attemptCount += 1;
    inv.nextPaymentAttempt = null;
  }

  /** What the next renewal will look like, without changing anything. */
  async getUpcomingInvoice(
    subscriptionId: string,
  ): Promise<ProviderInvoice | null> {
    const sub = await this.getSubscription(subscriptionId);
    if (!sub || sub.endedAt || sub.cancelAtPeriodEnd) return null;
    const c = await this.mustCustomer(sub.customerId);
    const target = (
      sub as ProviderSubscription & { scheduledTarget?: PriceRef }
    ).scheduledTarget;
    const interval = target?.interval ?? sub.interval;
    const subtotal = target?.amount ?? sub.amount;
    const start = ms(sub.currentPeriodEnd);
    const discountAmount = discountAmountFor(sub.discount, subtotal);
    const creditApplied = Math.min(c.creditBalance, subtotal - discountAmount);
    const preview = this.newInvoice(
      { ...sub, planId: target?.planId ?? sub.planId, interval },
      {
        billingReason: "upcoming",
        periodStart: start,
        periodEnd: addInterval(start, interval),
        subtotal,
        discountAmount,
        creditApplied,
        lines: [
          {
            description: `${target?.planId ?? sub.planId} (${interval})`,
            amount: subtotal,
            proration: false,
          },
        ],
        discount: sub.discount,
      },
    );
    preview.id = `upcoming_${sub.id}`;
    preview.createdAt = sub.currentPeriodEnd;
    return preview;
  }

  async getInvoice(invoiceId: string): Promise<ProviderInvoice | null> {
    return this.read<ProviderInvoice>(C.invoices, invoiceId);
  }

  async listInvoices(customerId: string): Promise<ProviderInvoice[]> {
    return (await this.all<ProviderInvoice>(C.invoices))
      .filter((i) => i.customerId === customerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getInvoiceDocument(invoiceId: string): Promise<InvoiceDocument> {
    const inv = await this.getInvoice(invoiceId);
    if (!inv) throw new Error(`no such invoice ${invoiceId}`);
    const money = (n: number) => `${(n / 100).toFixed(2)} ${inv.currency}`;
    const esc = (s: string) =>
      s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const rows = inv.lines
      .map(
        (l) =>
          `<tr><td>${esc(l.description)}</td><td style="text-align:right">${money(l.amount)}</td></tr>`,
      )
      .join("");
    return {
      kind: "html",
      html: `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(inv.number)}</title></head><body style="font-family:system-ui;max-width:640px;margin:40px auto">
<h1>${inv.status === "paid" ? "Receipt" : "Invoice"} ${esc(inv.number)}</h1>
<p>TEST MODE — simulated by the fake billing provider. No money moved.</p>
<p>Period: ${inv.periodStart.slice(0, 10)} to ${inv.periodEnd.slice(0, 10)} · Status: ${inv.status}</p>
<table style="width:100%;border-collapse:collapse">${rows}
<tr><td><b>Total</b></td><td style="text-align:right"><b>${money(inv.total)}</b></td></tr>
<tr><td>Paid</td><td style="text-align:right">${money(inv.amountPaid)}</td></tr></table></body></html>`,
    };
  }

  // ── portal ────────────────────────────────────────────────────────────

  async createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const id = this.id("bps");
    await this.db.collection(C.portal).doc(id).set({
      id,
      customerId: input.customerId,
      returnUrl: input.returnUrl,
      createdAt: this.clock.nowIso(),
    });
    return { url: `${this.opts.appUrl}/billing/portal?session=${id}` };
  }

  async getPortalSession(
    id: string,
  ): Promise<{ id: string; customerId: string; returnUrl: string } | null> {
    return this.read(C.portal, id);
  }

  /** Portal "update card": saves the card and retries any open invoice now. */
  async updateCard(
    customerId: string,
    card: FakeCardBehavior,
  ): Promise<{ retried: number; paid: number }> {
    const c = await this.mustCustomer(customerId);
    c.card = card;
    await this.write(C.customers, c);
    let retried = 0;
    let paid = 0;
    for (const sub of await this.listSubscriptions()) {
      if (sub.customerId !== customerId || sub.status !== "past_due") continue;
      retried++;
      if (await this.retry(sub)) paid++;
    }
    return { retried, paid };
  }

  // ── promotions ────────────────────────────────────────────────────────

  async syncPromotion(promo: PromoMirror): Promise<Record<string, string>> {
    const ref = `fpromo_${promo.id}`;
    await this.db
      .collection(C.promotions)
      .doc(ref)
      .set({ id: ref, promoId: promo.id, code: promo.code, active: true });
    return { fakePromotionId: ref };
  }

  async deactivatePromotion(promo: PromoMirror): Promise<void> {
    const ref = promo.providerRefs?.fakePromotionId;
    if (ref)
      await this.db
        .collection(C.promotions)
        .doc(ref)
        .set({ id: ref, promoId: promo.id, code: promo.code, active: false });
  }

  // ── refunds / disputes (test tools) ───────────────────────────────────

  async refundInvoice(invoiceId: string, amount?: number): Promise<void> {
    const inv = await this.getInvoice(invoiceId);
    inv.amountRefunded = Math.min(inv.amountPaid, amount ?? inv.amountPaid);
    await this.write(C.invoices, inv);
    await this.emit("charge.refunded", {
      uid: inv.uid,
      customerId: inv.customerId,
      invoiceId: inv.id,
      subscriptionId: inv.subscriptionId,
      amount: inv.amountRefunded,
    });
  }

  async disputeInvoice(invoiceId: string): Promise<void> {
    const inv = await this.getInvoice(invoiceId);
    await this.emit("charge.dispute_created", {
      uid: inv.uid,
      customerId: inv.customerId,
      invoiceId: inv.id,
      subscriptionId: inv.subscriptionId,
      amount: inv.amountPaid,
    });
  }

  // ── time ──────────────────────────────────────────────────────────────

  /**
   * Moves the clock to `targetMs`, processing every renewal, retry, reminder,
   * period-end cancel and checkout expiry that falls due on the way, in order.
   */
  async advanceTo(targetMs: number): Promise<{ processed: string[] }> {
    const processed: string[] = [];
    for (let guard = 0; guard < 10_000; guard++) {
      const next = await this.nextDue();
      if (!next || next.at > targetMs) break;
      if (next.at > this.clock.now()) this.clock.setNow(next.at);
      await next.run();
      processed.push(next.label);
    }
    if (targetMs > this.clock.now()) this.clock.setNow(targetMs);
    return { processed };
  }

  async advanceDays(days: number): Promise<{ processed: string[] }> {
    return this.advanceTo(this.clock.now() + days * DAY);
  }

  private async nextDue(): Promise<{
    at: number;
    label: string;
    run: () => Promise<unknown>;
  } | null> {
    const due: Array<{
      at: number;
      label: string;
      run: () => Promise<unknown>;
    }> = [];
    for (const s of await this.all<CheckoutSession>(C.checkouts)) {
      if (s.status === "open")
        due.push({
          at: ms(s.expiresAt),
          label: `expire ${s.id}`,
          run: () => this.expireCheckout(s),
        });
    }
    for (const sub of await this.listSubscriptions()) {
      const end = ms(sub.currentPeriodEnd);
      const meta = sub as ProviderSubscription & {
        reminderSentFor?: string;
        nextRetryAt?: string;
      };
      if (sub.status === "past_due" && meta.nextRetryAt) {
        due.push({
          at: ms(meta.nextRetryAt),
          label: `retry ${sub.id}`,
          run: () => this.retry(sub),
        });
      }
      if (
        !sub.cancelAtPeriodEnd &&
        meta.reminderSentFor !== sub.currentPeriodEnd &&
        sub.status !== "past_due"
      ) {
        const at = end - FAKE_UPCOMING_DAYS * DAY;
        if (at > ms(sub.currentPeriodStart))
          due.push({
            at,
            label: `upcoming ${sub.id}`,
            run: () => this.sendUpcoming(sub),
          });
      }
      due.push({
        at: end,
        label: `${sub.cancelAtPeriodEnd ? "end" : "renew"} ${sub.id}`,
        run: () => this.renewOrEnd(sub),
      });
    }
    due.sort((a, b) => a.at - b.at);
    return due[0] ?? null;
  }

  private async sendUpcoming(sub: ProviderSubscription): Promise<void> {
    (
      sub as ProviderSubscription & { reminderSentFor?: string }
    ).reminderSentFor = sub.currentPeriodEnd;
    await this.write(C.subscriptions, sub);
    await this.emit("invoice.upcoming", {
      uid: sub.uid,
      customerId: sub.customerId,
      subscriptionId: sub.id,
      amount: (await this.getUpcomingInvoice(sub.id))?.total ?? null,
    });
  }

  private async renewOrEnd(sub: ProviderSubscription): Promise<void> {
    const end = ms(sub.currentPeriodEnd);
    if (sub.cancelAtPeriodEnd) {
      sub.status = "canceled";
      sub.canceledAt = sub.canceledAt ?? iso(end);
      sub.endedAt = iso(end);
      sub.updatedAt = this.clock.now();
      await this.write(C.subscriptions, sub);
      await this.emit("subscription.deleted", {
        uid: sub.uid,
        customerId: sub.customerId,
        subscriptionId: sub.id,
      });
      return;
    }
    const target = (
      sub as ProviderSubscription & { scheduledTarget?: PriceRef }
    ).scheduledTarget;
    if (target) {
      sub.planId = target.planId;
      sub.interval = target.interval;
      sub.amount = target.amount;
      sub.priceLookupKey = target.lookupKey;
      sub.scheduledChange = null;
      delete (sub as ProviderSubscription & { scheduledTarget?: PriceRef })
        .scheduledTarget;
    }
    const newEnd = addInterval(end, sub.interval);
    const c = await this.mustCustomer(sub.customerId);
    const subtotal = sub.amount;
    const discountAmount = discountAmountFor(sub.discount, subtotal);
    const creditApplied = Math.min(c.creditBalance, subtotal - discountAmount);
    const inv = this.newInvoice(sub, {
      billingReason: "subscription_cycle",
      periodStart: end,
      periodEnd: newEnd,
      subtotal,
      discountAmount,
      creditApplied,
      lines: [
        {
          description: `${sub.planId} (${sub.interval})`,
          amount: subtotal,
          proration: false,
        },
      ],
      discount: sub.discount,
    });
    sub.discount = consumeDiscount(sub.discount);
    c.creditBalance -= creditApplied;
    sub.currentPeriodStart = iso(end);
    sub.currentPeriodEnd = iso(newEnd);
    sub.latestInvoiceId = inv.id;
    const outcome =
      inv.total === 0 ? ({ ok: true } as ChargeOutcome) : this.charge(c, false);
    if (outcome.ok === true) {
      this.markPaid(inv);
      if (inv.total > 0) c.successfulCharges++;
      sub.status = "active";
      sub.pastDueSince = null;
      sub.updatedAt = this.clock.now();
      await this.write(C.customers, c);
      await this.write(C.invoices, inv);
      await this.write(C.subscriptions, sub);
      await this.emit("invoice.paid", {
        uid: sub.uid,
        customerId: c.id,
        subscriptionId: sub.id,
        invoiceId: inv.id,
        amount: inv.amountPaid,
      });
      await this.emit("subscription.updated", {
        uid: sub.uid,
        customerId: c.id,
        subscriptionId: sub.id,
      });
      return;
    }
    const code =
      outcome.ok === false ? outcome.code : "authentication_required";
    inv.attemptCount = 1;
    inv.nextPaymentAttempt = iso(end + FAKE_RETRY_DAYS[0] * DAY);
    (inv as ProviderInvoice & { failureCode?: string }).failureCode = code;
    sub.status = "past_due";
    sub.pastDueSince = sub.pastDueSince ?? iso(end);
    (sub as ProviderSubscription & { nextRetryAt?: string }).nextRetryAt =
      inv.nextPaymentAttempt;
    sub.updatedAt = this.clock.now();
    await this.write(C.customers, c);
    await this.write(C.invoices, inv);
    await this.write(C.subscriptions, sub);
    if (code === "authentication_required") {
      await this.emit("invoice.action_required", {
        uid: sub.uid,
        customerId: c.id,
        subscriptionId: sub.id,
        invoiceId: inv.id,
        amount: inv.total,
      });
    }
    await this.emit("invoice.payment_failed", {
      uid: sub.uid,
      customerId: c.id,
      subscriptionId: sub.id,
      invoiceId: inv.id,
      amount: inv.total,
    });
    await this.emit("subscription.updated", {
      uid: sub.uid,
      customerId: c.id,
      subscriptionId: sub.id,
    });
  }

  /** One retry of the open renewal invoice. Returns true when it was paid. */
  private async retry(sub: ProviderSubscription): Promise<boolean> {
    const inv = sub.latestInvoiceId
      ? await this.getInvoice(sub.latestInvoiceId)
      : null;
    if (!inv || inv.status !== "open") return false;
    const c = await this.mustCustomer(sub.customerId);
    const outcome = this.charge(c, false);
    const meta = sub as ProviderSubscription & { nextRetryAt?: string };
    if (outcome.ok === true) {
      this.markPaid(inv);
      c.successfulCharges++;
      sub.status = "active";
      sub.pastDueSince = null;
      delete meta.nextRetryAt;
      sub.updatedAt = this.clock.now();
      await this.write(C.customers, c);
      await this.write(C.invoices, inv);
      await this.write(C.subscriptions, sub);
      await this.emit("invoice.paid", {
        uid: sub.uid,
        customerId: c.id,
        subscriptionId: sub.id,
        invoiceId: inv.id,
        amount: inv.amountPaid,
      });
      await this.emit("subscription.updated", {
        uid: sub.uid,
        customerId: c.id,
        subscriptionId: sub.id,
      });
      return true;
    }
    inv.attemptCount += 1;
    const pastDueSince = ms(sub.pastDueSince ?? inv.periodStart);
    const nextDay = FAKE_RETRY_DAYS[inv.attemptCount - 1];
    if (nextDay === undefined) {
      inv.status = "uncollectible";
      inv.nextPaymentAttempt = null;
      sub.status = "canceled";
      sub.canceledAt = this.clock.nowIso();
      sub.endedAt = this.clock.nowIso();
      delete meta.nextRetryAt;
      sub.updatedAt = this.clock.now();
      await this.write(C.invoices, inv);
      await this.write(C.subscriptions, sub);
      await this.emit("invoice.payment_failed", {
        uid: sub.uid,
        customerId: c.id,
        subscriptionId: sub.id,
        invoiceId: inv.id,
        amount: inv.total,
      });
      await this.emit("subscription.deleted", {
        uid: sub.uid,
        customerId: c.id,
        subscriptionId: sub.id,
      });
      return false;
    }
    inv.nextPaymentAttempt = iso(pastDueSince + nextDay * DAY);
    meta.nextRetryAt = inv.nextPaymentAttempt;
    sub.updatedAt = this.clock.now();
    await this.write(C.invoices, inv);
    await this.write(C.subscriptions, sub);
    await this.emit("invoice.payment_failed", {
      uid: sub.uid,
      customerId: c.id,
      subscriptionId: sub.id,
      invoiceId: inv.id,
      amount: inv.total,
    });
    return false;
  }

  /** Throws PaymentDeclinedError — kept for API symmetry with Stripe errors. */
  static declined(code: string): never {
    throw new PaymentDeclinedError(code);
  }
}
