import { emailHash } from "./retention/email-normalise";
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ReferralService } from "./referral/referral.service";
import { AppClock } from "../common/app-clock";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  DEFAULT_PLAN_ID,
  planById,
  planRank,
  type SubscriptionStatus,
} from "../plans/plans.registry";
import {
  SubscriptionsService,
  type SubscriptionMirror,
} from "../plans/subscriptions.service";
import { EmailService } from "./email/email.service";
import {
  BILLING_PROVIDER,
  InvalidEventSignatureError,
  type BillingProvider,
} from "./provider/billing-provider";
import { FakeBillingProvider } from "./provider/fake/fake-billing.provider";
import type {
  ProviderEvent,
  ProviderInvoice,
  ProviderSubscription,
  ProviderSubscriptionStatus,
  ScheduledChange,
} from "./provider/types";

/**
 * The billing event handler — webhook logic, provider-agnostic.
 *
 * THE ONLY WRITER of:
 *   subscriptions/{uid}   mirror of the provider subscription (plan, status, period, discount…)
 *   customers/{uid}       provider customer id
 *   payments/{invoiceId}  one row per invoice (SUCCESS / FAILED / REFUNDED / DISPUTED)
 *   subscription_events   plan-change history
 *   users/{uid}           plan projection fields (currentPlan, subscriptionStatus, dates…)
 *   the `plan` custom claim
 * (plus applyLaunchTrial, the documented launch-day grant).
 *
 * Guarantees:
 *   - signature verified on the raw body (provider.parseEvent) → 400 when bad
 *   - idempotent by event id (stripe_events/{id}); a failed event is retried
 *   - ordering-safe: state is re-fetched from the provider, never taken from
 *     the event payload, and a late event about an older subscription cannot
 *     overwrite a newer live one
 */

export const BILLING_COLLECTIONS = {
  subscriptions: "subscriptions",
  customers: "customers",
  payments: "payments",
  events: "subscription_events",
  processed: "stripe_events",
  checkouts: "checkout_sessions",
  promoCodes: "promo_codes",
  promoRedemptions: "promo_redemptions",
} as const;

const LIVE: SubscriptionStatus[] = ["ACTIVE", "TRIALING", "PAST_DUE"];

export function mapStatus(s: ProviderSubscriptionStatus): SubscriptionStatus {
  switch (s) {
    case "active":
      return "ACTIVE";
    case "trialing":
      return "TRIALING";
    case "past_due":
      return "PAST_DUE";
    case "incomplete":
      return "NONE";
    default:
      return "CANCELLED";
  }
}

export interface MirrorDoc extends SubscriptionMirror {
  provider: string;
  /** false = written by a test-mode provider (excluded from revenue; purgeable). */
  livemode?: boolean;
  /** Renewal consent from checkout (copied from checkout_sessions). */
  consent?: Record<string, unknown> | null;
  customerId: string | null;
  subscriptionId: string | null;
  providerStatus: string | null;
  canceledAt: string | null;
  endedAt: string | null;
  discount: Record<string, unknown> | null;
  scheduledChange: ScheduledChange | null;
  amount: number | null;
  currency: string | null;
  providerUpdatedAt: number | null;
  lastEventId: string | null;
  lastEventCreated: number | null;
  promoCode?: string | null;
  updatedAt: string;
}

export type HandleResult = "processed" | "duplicate" | "ignored";

/**
 * Removes `undefined` (Firestore rejects it) — deep, keeping null — so a
 * provider field that happens to be absent can never fail an event.
 */
export function clean<T>(value: T): T {
  if (Array.isArray(value))
    return value.map((v: unknown) => clean(v)) as unknown as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, clean(v)]),
    ) as T;
  }
  return value;
}

@Injectable()
export class BillingEventsService implements OnModuleInit {
  private readonly logger = new Logger(BillingEventsService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider | null,
    private readonly subscriptions: SubscriptionsService,
    private readonly emails: EmailService,
    private readonly clock: AppClock,
    @Optional() private readonly referrals?: ReferralService,
  ) {}

  onModuleInit(): void {
    // The fake provider "sends webhooks" by calling us in-process through the
    // same signature check the HTTP webhook uses.
    if (this.provider instanceof FakeBillingProvider) {
      this.provider.setEventSink(async (raw, sig) => {
        await this.receive(raw, sig);
      });
    }
  }

  private get db() {
    return this.firebase.firestore;
  }

  /** Entry point for POST /api/billing/webhook and the fake provider. */
  async receive(
    rawBody: Buffer | string,
    signature: string | undefined,
  ): Promise<HandleResult> {
    if (!this.provider) {
      throw new ServiceUnavailableException("No billing provider configured.");
    }
    let event: ProviderEvent | null;
    try {
      event = await this.provider.parseEvent(rawBody, signature);
    } catch (err) {
      if (err instanceof InvalidEventSignatureError) {
        throw new BadRequestException({
          code: "invalid_signature",
          message: "Invalid webhook signature.",
        });
      }
      throw err;
    }
    if (!event?.id || !event.type) return "ignored";
    return this.handle(event);
  }

  /** Idempotent processing of one verified event. */
  async handle(event: ProviderEvent): Promise<HandleResult> {
    const marker = this.db
      .collection(BILLING_COLLECTIONS.processed)
      .doc(event.id);
    const claimed = await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(marker);
      if (snap.exists && snap.data()?.status === "processed") return false;
      tx.set(marker, {
        id: event.id,
        type: event.type,
        provider: event.provider,
        created: event.created,
        receivedAt: this.clock.nowIso(),
        status: "processing",
        ...this.mode(),
      });
      return true;
    });
    if (!claimed) return "duplicate";
    try {
      await this.process(event);
      await marker.set(
        { status: "processed", processedAt: this.clock.nowIso() },
        { merge: true },
      );
      return "processed";
    } catch (err) {
      await marker.set(
        { status: "failed", error: (err as Error).message },
        { merge: true },
      );
      this.logger.error(
        `event ${event.id} (${event.type}) failed: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  private async process(event: ProviderEvent): Promise<void> {
    const d = event.data;
    switch (event.type) {
      case "subscription.created":
      case "subscription.updated":
      case "subscription.deleted":
        if (d.subscriptionId)
          await this.syncSubscription(d.subscriptionId, event);
        return;
      case "checkout.completed":
        await this.onCheckoutCompleted(event);
        if (d.subscriptionId)
          await this.syncSubscription(d.subscriptionId, event);
        // Stripe: the first invoice.paid IS the checkout completion — record that payment too.
        if (d.invoiceId) await this.syncInvoice(d.invoiceId, event);
        return;
      case "checkout.card_saved":
        // Free trial: the card is saved — start the trialing subscription
        // (idempotent); its own events then write the mirror.
        if (d.checkoutSessionId && this.provider)
          await this.provider.getCheckout(d.checkoutSessionId);
        return;
      case "checkout.expired":
        if (d.checkoutSessionId) {
          await this.db
            .collection(BILLING_COLLECTIONS.checkouts)
            .doc(d.checkoutSessionId)
            .set(
              { status: "expired", expiredAt: this.clock.nowIso() },
              { merge: true },
            );
        }
        return;
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.action_required":
        if (d.invoiceId) await this.syncInvoice(d.invoiceId, event);
        return;
      case "invoice.upcoming":
        await this.onUpcoming(event);
        return;
      case "charge.refunded":
      case "charge.dispute_created":
        if (d.invoiceId) await this.onChargeIssue(event);
        return;
      default:
        return;
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────

  /** trial_claims/{emailHash}: one free trial per person, ever. Idempotent. */
  private async claimTrial(uid: string, planId: string): Promise<void> {
    const email = await this.emailFor(uid);
    if (!email) return;
    const ref = this.db.collection("trial_claims").doc(emailHash(email));
    if ((await ref.get()).exists) return;
    await ref.set({ uid, planId, claimedAt: this.clock.nowIso(), ...this.mode() });
  }

  /** { livemode } of the active provider; nothing when there is none (trials). */
  private mode(): { livemode?: boolean } {
    return this.provider ? { livemode: this.provider.livemode } : {};
  }

  private async emailFor(uid: string): Promise<string | null> {
    const c = (
      await this.db.collection(BILLING_COLLECTIONS.customers).doc(uid).get()
    ).data();
    if (c?.email) return String(c.email);
    try {
      return (await this.firebase.auth.getUser(uid)).email ?? null;
    } catch {
      return null;
    }
  }

  private async ensureCustomer(uid: string, customerId: string): Promise<void> {
    const ref = this.db.collection(BILLING_COLLECTIONS.customers).doc(uid);
    const snap = await ref.get();
    if (snap.exists && snap.data()?.customerId === customerId) return;
    let email: string | null = null;
    try {
      email = (await this.firebase.auth.getUser(uid)).email ?? null;
    } catch {
      email = null;
    }
    await ref.set(
      {
        uid,
        provider: this.provider?.name ?? null,
        ...this.mode(),
        customerId,
        email: email ? email.trim().toLowerCase() : null,
        createdAt:
          (snap.data()?.createdAt as string | undefined) ?? this.clock.nowIso(),
        updatedAt: this.clock.nowIso(),
      },
      { merge: true },
    );
  }

  private async setPlanClaim(uid: string): Promise<void> {
    const effective = await this.subscriptions.forUser(uid);
    try {
      const user = await this.firebase.auth.getUser(uid);
      const claims = { ...(user.customClaims ?? {}), plan: effective.planId };
      await this.firebase.auth.setCustomUserClaims(uid, claims);
    } catch (err) {
      this.logger.warn(
        `plan claim not set for ${uid}: ${(err as Error).message}`,
      );
    }
  }

  private async writeProjection(uid: string, m: MirrorDoc): Promise<void> {
    const live = LIVE.includes(m.status);
    await this.db
      .collection("users")
      .doc(uid)
      .set(
        {
          currentPlan: live ? m.planId : DEFAULT_PLAN_ID,
          subscriptionStatus: m.status,
          subscriptionInterval: m.interval ?? null,
          subscriptionStartDate: m.startedAt ?? null,
          subscriptionExpiryDate: m.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: m.cancelAtPeriodEnd === true,
          pastDueSince: m.pastDueSince ?? null,
        },
        { merge: true },
      );
  }

  private async addHistory(
    uid: string,
    type: string,
    from: unknown,
    to: unknown,
    ctx: { eventId?: string | null; subscriptionId?: string | null },
  ): Promise<void> {
    await this.db
      .collection(BILLING_COLLECTIONS.events)
      .doc()
      .set(
        clean({
          uid,
          type,
          from: from ?? null,
          to: to ?? null,
          at: this.clock.nowIso(),
          eventId: ctx.eventId ?? null,
          subscriptionId: ctx.subscriptionId ?? null,
          ...this.mode(),
        }),
      );
  }

  /** Our checkout record for this subscription (promo code, renewal consent), if any. */
  private async checkoutRecordFor(
    subscriptionId: string,
  ): Promise<Record<string, unknown> | null> {
    const snap = await this.db
      .collection(BILLING_COLLECTIONS.checkouts)
      .where("subscriptionId", "==", subscriptionId)
      .limit(1)
      .get();
    return snap.empty ? null : snap.docs[0].data();
  }

  /** The promo code used at checkout for this subscription, if any. */
  private async promoCodeFor(subscriptionId: string): Promise<string | null> {
    return (
      ((await this.checkoutRecordFor(subscriptionId))?.promoCode as
        string | null) ?? null
    );
  }

  // ── subscriptions ─────────────────────────────────────────────────────

  /** Re-fetches the subscription from the provider and writes all derived state. */
  async syncSubscription(
    subscriptionId: string,
    event: ProviderEvent | null,
  ): Promise<HandleResult> {
    if (!this.provider) return "ignored";
    const sub = await this.provider.getSubscription(subscriptionId);
    if (!sub || !sub.uid) return "ignored";
    return this.applySubscription(sub, event);
  }

  /** Writes mirror/projection/claim/history for a freshly fetched provider subscription. */
  async applySubscription(
    sub: ProviderSubscription,
    event: ProviderEvent | null,
  ): Promise<HandleResult> {
    const uid = sub.uid;
    const ref = this.db.collection(BILLING_COLLECTIONS.subscriptions).doc(uid);
    const prev = (await ref.get()).data() as MirrorDoc | undefined;
    const status = mapStatus(sub.status);

    // Ordering: a late event about an OLDER subscription must not replace a
    // newer live one (e.g. old sub's deletion arriving after a re-subscribe).
    if (
      prev &&
      prev.subscriptionId &&
      prev.subscriptionId !== sub.id &&
      LIVE.includes(prev.status) &&
      !LIVE.includes(status)
    ) {
      this.logger.log(
        `ignoring ${sub.id} (${status}): ${uid} has newer live subscription ${prev.subscriptionId}`,
      );
      return "ignored";
    }
    if (
      prev &&
      prev.subscriptionId &&
      prev.subscriptionId !== sub.id &&
      LIVE.includes(prev.status) &&
      LIVE.includes(status)
    ) {
      // Should never happen (checkout refuses a second subscription); if it
      // does, the customer may be billed twice — flag it for an admin.
      this.logger.error(
        `DUPLICATE SUBSCRIPTION for ${uid}: ${prev.subscriptionId} and ${sub.id} are both live`,
      );
      await this.db
        .collection("billing_alerts")
        .doc(`duplicate_${uid}_${sub.id}`)
        .set({
          kind: "duplicate_subscription",
          uid,
          subscriptionIds: [prev.subscriptionId, sub.id],
          at: this.clock.nowIso(),
          ...this.mode(),
        });
    }
    if (
      prev &&
      prev.subscriptionId === sub.id &&
      prev.providerUpdatedAt != null &&
      sub.updatedAt < prev.providerUpdatedAt
    ) {
      return "ignored"; // stale snapshot
    }

    await this.ensureCustomer(uid, sub.customerId);
    const next: MirrorDoc = {
      uid,
      provider: this.provider?.name ?? "unknown",
      ...this.mode(),
      source: "provider",
      customerId: sub.customerId,
      subscriptionId: sub.id,
      planId: sub.planId,
      interval: sub.interval,
      status,
      providerStatus: sub.status,
      startedAt: sub.startedAt,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      canceledAt: sub.canceledAt,
      endedAt: sub.endedAt,
      pastDueSince: sub.pastDueSince,
      discount: sub.discount
        ? (JSON.parse(JSON.stringify(sub.discount)) as Record<string, unknown>)
        : null,
      scheduledChange: sub.scheduledChange ? { ...sub.scheduledChange } : null,
      amount: sub.amount,
      currency: sub.currency,
      providerUpdatedAt: sub.updatedAt,
      lastEventId: event?.id ?? prev?.lastEventId ?? null,
      lastEventCreated:
        Math.max(event?.created ?? 0, prev?.lastEventCreated ?? 0) || null,
      promoCode: prev?.promoCode ?? (await this.promoCodeFor(sub.id)),
      // Renewal consent shown and ticked at checkout (timestamp, text version, plan, price, IP).
      consent:
        (prev?.consent as Record<string, unknown> | undefined) ??
        ((await this.checkoutRecordFor(sub.id))?.consent as
          Record<string, unknown> | undefined) ??
        null,
      updatedAt: this.clock.nowIso(),
    };
    await ref.set(clean(next));
    // A provider trial uses up this person's one free trial (normalised email).
    if (status === "TRIALING" && !(prev?.status === "TRIALING" && prev?.source === "provider"))
      await this.claimTrial(uid, next.planId);
    await this.writeProjection(uid, next);
    await this.setPlanClaim(uid);
    await this.recordChanges(uid, prev, next, event);
    await this.db.collection("abandoned_checkouts").doc(uid).delete().catch(() => {});
    return "processed";
  }

  private async recordChanges(
    uid: string,
    prev: MirrorDoc | undefined,
    next: MirrorDoc,
    event: ProviderEvent | null,
  ): Promise<void> {
    const ctx = { eventId: event?.id, subscriptionId: next.subscriptionId };
    const email = await this.emailFor(uid);
    const samesub = prev?.subscriptionId === next.subscriptionId;
    const nowLive = LIVE.includes(next.status);
    const wasLive = prev ? LIVE.includes(prev.status) : false;

    if ((!prev || !samesub || (!wasLive && nowLive)) && nowLive) {
      await this.addHistory(
        uid,
        "subscribed",
        prev?.planId
          ? { planId: prev.planId, status: prev.status ?? null }
          : null,
        { planId: next.planId, interval: next.interval, status: next.status },
        ctx,
      );

      return; // welcome email is sent from checkout.completed
    }
    if (prev.planId !== next.planId || prev.interval !== next.interval) {
      await this.addHistory(
        uid,
        "plan_changed",
        { planId: prev.planId, interval: prev.interval },
        { planId: next.planId, interval: next.interval },
        ctx,
      );
      const up =
        planRank(next.planId) > planRank(prev.planId) ||
        (next.planId === prev.planId && next.interval === "annual");
      if (up && !prev.scheduledChange) {
        await this.emails.upgrade(email, {
          fromPlanId: prev.planId,
          planId: next.planId,
          interval: next.interval,
          charged: null,
          currency: next.currency ?? "USD",
          renewsAt: next.currentPeriodEnd,
        });
      } else if (!up && !prev.scheduledChange) {
        // An immediate downgrade (a scheduled one emailed when it was scheduled).
        const credit =
          this.provider && next.customerId
            ? await this.provider.getCreditBalance(next.customerId).catch(() => null)
            : null;
        await this.emails.downgraded(email, {
          fromPlanId: prev.planId,
          planId: next.planId,
          interval: next.interval ?? "monthly",
          creditBalance: credit,
          currency: next.currency ?? "USD",
          renewsAt: next.currentPeriodEnd,
        });
      }
    }
    if (!prev.scheduledChange && next.scheduledChange) {
      await this.addHistory(
        uid,
        "downgrade_scheduled",
        { planId: prev.planId, interval: prev.interval },
        next.scheduledChange,
        ctx,
      );
      await this.emails.downgradeScheduled(email, {
        fromPlanId: next.planId,
        planId: String(next.scheduledChange.planId),
        interval: String(next.scheduledChange.interval),
        effectiveAt: String(next.scheduledChange.effectiveAt),
      });
    } else if (
      prev.scheduledChange &&
      !next.scheduledChange &&
      prev.planId === next.planId
    ) {
      await this.addHistory(
        uid,
        "downgrade_cancelled",
        prev.scheduledChange,
        null,
        ctx,
      );
      await this.emails.scheduledChangeCancelled(email, {
        planId: next.planId,
        interval: next.interval ?? "monthly",
        renewsAt: next.currentPeriodEnd,
      });
    }
    if (!prev.cancelAtPeriodEnd && next.cancelAtPeriodEnd) {
      await this.addHistory(
        uid,
        "cancel_scheduled",
        null,
        { endsAt: next.currentPeriodEnd },
        ctx,
      );
      await this.emails.cancellation(email, {
        planId: next.planId,
        endsAt: next.currentPeriodEnd,
      });
    } else if (
      prev.cancelAtPeriodEnd &&
      !next.cancelAtPeriodEnd &&
      next.status !== "CANCELLED"
    ) {
      await this.addHistory(
        uid,
        "resumed",
        null,
        { renewsAt: next.currentPeriodEnd },
        ctx,
      );
      await this.emails.resumed(email, {
        planId: next.planId,
        renewsAt: next.currentPeriodEnd,
      });
    }
    const prevDiscount = JSON.stringify(prev.discount?.source ?? null);
    const nextDiscount = JSON.stringify(next.discount?.source ?? null);
    if (prevDiscount !== nextDiscount && next.discount) {
      await this.addHistory(
        uid,
        "discount_applied",
        prev.discount,
        next.discount,
        ctx,
      );
    }
    if (prev.status !== next.status) {
      await this.addHistory(
        uid,
        "status_changed",
        prev.status,
        next.status,
        ctx,
      );
      if (next.status === "CANCELLED")
        await this.emails.planEnded(email, { planId: prev.planId });
    }
  }

  // ── checkout ──────────────────────────────────────────────────────────

  private async onCheckoutCompleted(event: ProviderEvent): Promise<void> {
    const sessionId = event.data.checkoutSessionId;
    if (!sessionId || !this.provider) return;
    const session = await this.provider.getCheckout(sessionId);
    if (!session) return;
    await this.ensureCustomer(session.uid, session.customerId);
    const ref = this.db
      .collection(BILLING_COLLECTIONS.checkouts)
      .doc(sessionId);
    const record = (await ref.get()).data() ?? {};
    await ref.set(
      clean({
        status: "complete",
        completedAt: this.clock.nowIso(),
        ...this.mode(),
        subscriptionId: session.subscriptionId,
        promoCode:
          (record.promoCode as string | undefined) ??
          session.discount?.code ??
          null,
      }),
      { merge: true },
    );

    const promoId =
      (record.promoId as string | undefined) ??
      session.discount?.promoId ??
      null;
    if (promoId)
      await this.recordRedemption(
        promoId,
        session.uid,
        sessionId,
        session.planId,
        session.interval,
      );

    if (session.subscriptionId) {
      // The promo code reaches the mirror via checkout_sessions (promoCodeFor);
      // a partial subscriptions doc written here would precede the real
      // mirror and corrupt its first history entry.
      const sub = await this.provider.getSubscription(session.subscriptionId);
      await this.emails.welcome(await this.emailFor(session.uid), {
        planId: session.planId,
        interval: session.interval,
        amount: session.amountDueToday,
        currency: session.currency,
        renewsAt: sub?.currentPeriodEnd ?? this.clock.nowIso(),
        trialEndsAt:
          sub?.status === "trialing" ? sub.currentPeriodEnd : null,
        renewalAmount: sub?.amount ?? null,
      });
    }
  }

  /** Counts one redemption, once per checkout session, atomically. */
  private async recordRedemption(
    promoId: string,
    uid: string,
    sessionId: string,
    planId: string,
    interval: string,
  ): Promise<void> {
    const promoRef = this.db
      .collection(BILLING_COLLECTIONS.promoCodes)
      .doc(promoId);
    const redemptionRef = this.db
      .collection(BILLING_COLLECTIONS.promoRedemptions)
      .doc(sessionId);
    await this.db.runTransaction(async (tx) => {
      const [promo, existing] = await Promise.all([
        tx.get(promoRef),
        tx.get(redemptionRef),
      ]);
      if (existing.exists || !promo.exists) return;
      const data = promo.data() ?? {};
      tx.set(redemptionRef, {
        id: sessionId,
        promoId,
        code: data.code ?? null,
        uid,
        planId,
        interval,
        redeemedAt: this.clock.nowIso(),
        ...this.mode(),
      });
      tx.set(
        promoRef,
        { timesRedeemed: Number(data.timesRedeemed ?? 0) + 1 },
        { merge: true },
      );
    });
  }

  // ── invoices ──────────────────────────────────────────────────────────

  private paymentStatus(inv: ProviderInvoice, event: ProviderEvent): string {
    if (
      inv.amountRefunded > 0 &&
      inv.amountRefunded >= inv.amountPaid &&
      inv.amountPaid > 0
    )
      return "REFUNDED";
    if (inv.status === "paid") return "SUCCESS";
    if (event.type === "invoice.action_required") return "ACTION_REQUIRED";
    return "FAILED";
  }

  private async syncInvoice(
    invoiceId: string,
    event: ProviderEvent,
  ): Promise<void> {
    if (!this.provider) return;
    const inv = await this.provider.getInvoice(invoiceId);
    if (!inv || !inv.uid) return;
    await this.ensureCustomer(inv.uid, inv.customerId);
    const status = this.paymentStatus(inv, event);
    await this.db
      .collection(BILLING_COLLECTIONS.payments)
      .doc(inv.id)
      .set(
        {
          paymentId: inv.id,
          invoiceNumber: inv.number,
          userId: inv.uid,
          provider: this.provider.name,
          livemode: this.provider.livemode,
          customerId: inv.customerId,
          subscriptionId: inv.subscriptionId,
          planId: inv.planId,
          planName: planById(inv.planId)?.name ?? inv.planId,
          amount: inv.status === "paid" ? inv.amountPaid : inv.total,
          subtotal: inv.subtotal,
          discountAmount: inv.discountAmount,
          creditApplied: inv.creditApplied,
          amountRefunded: inv.amountRefunded,
          // Line items (description, period, amount, proration flag), incl.
          // discount and credit lines — what Manage Plan history and the admin
          // detail show. Written here only (the event handler).
          lines: (inv.lines ?? []).map((l) => ({
            description: l.description,
            amount: l.amount,
            proration: l.proration === true,
            periodStart: l.periodStart ?? null,
            periodEnd: l.periodEnd ?? null,
          })),
          currency: inv.currency,
          paymentStatus: status,
          billingReason: inv.billingReason,
          paymentDate: inv.paidAt ?? inv.createdAt,
          subscriptionStartDate: inv.periodStart,
          subscriptionExpiryDate: inv.periodEnd,
          billingCycle: inv.interval,
          attemptCount: inv.attemptCount,
          hostedInvoiceUrl: inv.hostedInvoiceUrl,
          invoicePdf: inv.invoicePdfUrl,
          updatedAt: this.clock.nowIso(),
        },
        { merge: true },
      );
    // A plan change confirmed by the bank (3-D Secure): finish it now it is paid.
    if (status === "SUCCESS" && this.provider.completePendingChange)
      await this.provider.completePendingChange(inv.id);
    const email = await this.emailFor(inv.uid);
    if (status === "SUCCESS") {
      const cref = this.db
        .collection(BILLING_COLLECTIONS.customers)
        .doc(inv.uid);
      const c = (await cref.get()).data();
      // The first real payment ($0 trial invoices don't count): it makes the
      // account a returning customer, and pays out a referral reward.
      if (!c?.firstPaidAt && inv.amountPaid > 0) {
        await cref.set(
          { firstPaidAt: inv.paidAt ?? this.clock.nowIso() },
          { merge: true },
        );
        if (this.referrals && inv.subscriptionId) {
          const promoCode =
            ((await this.checkoutRecordFor(inv.subscriptionId))?.promoCode as
              string | null | undefined) ??
            ((
              await this.db
                .collection(BILLING_COLLECTIONS.subscriptions)
                .doc(inv.uid)
                .get()
            ).data()?.promoCode as string | null | undefined);
          await this.referrals.rewardForFirstPayment(inv.uid, promoCode);
        }
      }
      // Every receipt goes through our EmailSender (SendGrid); turn off Stripe's
      // own customer receipt emails so customers don't get two (docs/GO-LIVE.md).
      await this.emails.receipt(email, {
        planId: inv.planId,
        amount: inv.amountPaid,
        currency: inv.currency,
        invoiceNumber: inv.number,
      });
    } else if (event.type === "invoice.action_required") {
      await this.emails.actionRequired(email, {
        planId: inv.planId,
        amount: inv.total,
        currency: inv.currency,
      });
    } else if (
      event.type === "invoice.payment_failed" &&
      inv.status !== "paid"
    ) {
      const effective = await this.subscriptions.forUser(inv.uid);
      await this.emails.paymentFailed(email, {
        planId: inv.planId,
        amount: inv.total,
        currency: inv.currency,
        graceEndsAt: effective.graceEndsAt,
      });
    }
  }

  private async onUpcoming(event: ProviderEvent): Promise<void> {
    if (!this.provider || !event.data.subscriptionId) return;
    const upcoming = await this.provider.getUpcomingInvoice(
      event.data.subscriptionId,
    );
    if (!upcoming) return;
    await this.emails.renewalReminder(await this.emailFor(upcoming.uid), {
      planId: upcoming.planId,
      interval: upcoming.interval,
      amount: upcoming.total,
      currency: upcoming.currency,
      renewsAt: upcoming.periodStart,
    });
  }

  private async onChargeIssue(event: ProviderEvent): Promise<void> {
    const ref = this.db
      .collection(BILLING_COLLECTIONS.payments)
      .doc(event.data.invoiceId);
    if (event.type === "charge.refunded") {
      const inv = this.provider
        ? await this.provider.getInvoice(event.data.invoiceId)
        : null;
      const refunded = inv?.amountRefunded ?? event.data.amount ?? 0;
      const full = inv ? refunded >= inv.amountPaid : false;
      await ref.set(
        {
          amountRefunded: refunded,
          paymentStatus: full ? "REFUNDED" : "SUCCESS",
          refundedAt: this.clock.nowIso(),
        },
        { merge: true },
      );
    } else {
      await ref.set(
        { disputed: true, disputedAt: this.clock.nowIso() },
        { merge: true },
      );
    }
  }

  // ── launch-day trial (decision i) ─────────────────────────────────────

  /**
   * The one sanctioned non-provider write: a backend-granted TRIALING period
   * for existing users at launch. Never overwrites a paying subscription.
   */
  async applyLaunchTrial(
    uid: string,
    planId: string,
    endsAt: string,
  ): Promise<"granted" | "skipped"> {
    const ref = this.db.collection(BILLING_COLLECTIONS.subscriptions).doc(uid);
    const prev = (await ref.get()).data() as MirrorDoc | undefined;
    if (prev && LIVE.includes(prev.status)) return "skipped";
    const now = this.clock.nowIso();
    const next: MirrorDoc = {
      uid,
      provider: "launch_trial",
      source: "launch_trial",
      customerId: prev?.customerId ?? null,
      subscriptionId: null,
      planId,
      interval: null,
      status: "TRIALING",
      providerStatus: null,
      startedAt: now,
      currentPeriodStart: now,
      currentPeriodEnd: endsAt,
      cancelAtPeriodEnd: true,
      canceledAt: null,
      endedAt: null,
      pastDueSince: null,
      discount: null,
      scheduledChange: null,
      amount: 0,
      currency: null,
      providerUpdatedAt: null,
      lastEventId: null,
      lastEventCreated: null,
      updatedAt: now,
    };
    await ref.set(clean(next));
    await this.writeProjection(uid, next);
    await this.setPlanClaim(uid);
    await this.addHistory(
      uid,
      "launch_trial",
      null,
      { planId, endsAt },
      { eventId: null, subscriptionId: null },
    );
    return "granted";
  }
}
