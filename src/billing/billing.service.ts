import { CONSENT_VERSION, consentText } from "./checkout/consent";
import {
  addInterval as addIntervalMs,
  discountAmountFor,
  normaliseDiscount,
} from "./provider/fake/fake-billing.provider";
import { refundPolicy } from "./refund/refund-policy";
import { emailHash } from "./retention/email-normalise";
import { buildTimeline } from "./history-format";
import { EmailVerificationService } from "../account/email-verification.service";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { AppClock } from "../common/app-clock";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  BILLING_INTERVALS,
  catalogPrice,
  isPaidPlanId,
  planById,
  planRank,
  type BillingInterval,
  TRIAL_DAYS,
} from "../plans/plans.registry";
import { SubscriptionsService } from "../plans/subscriptions.service";
import { BillingAccessService } from "./billing-access.service";
import { inCheckoutPreview } from "./checkout-preview";
import type { MirrorDoc } from "./billing-events.service";
import {
  PreviewStaleError,
  type BillingProvider,
} from "./provider/billing-provider";
import type { AppliedDiscount, PriceRef } from "./provider/types";
import {
  describePromo,
  GENERIC_PROMO_ERROR,
  PromoService,
} from "./promo/promo.service";

/**
 * User-facing billing operations. Every method asks the provider to do
 * something and returns; resulting state arrives through provider events
 * (BillingEventsService) — this service never writes subscription, customer,
 * payment or plan fields itself. It records only checkout intents
 * (checkout_sessions), which carry no entitlement.
 */

const LIVE = ["ACTIVE", "TRIALING", "PAST_DUE"];

export type ChangeKind = "upgrade" | "downgrade" | "scheduled" | "same";

/**
 * upgrade   higher plan on the same interval, or monthly → annual (any plan):
 *           immediate, prorated, charged now
 * downgrade lower plan on the same interval: immediate, prorated, the
 *           difference credited to the account balance
 * scheduled annual → monthly (any plan): at the end of the annual period
 */
export function classifyChange(
  current: { planId: string; interval: BillingInterval },
  target: { planId: string; interval: BillingInterval },
): ChangeKind {
  if (current.planId === target.planId && current.interval === target.interval)
    return "same";
  if (current.interval === "annual" && target.interval === "monthly")
    return "scheduled";
  if (current.interval === "monthly" && target.interval === "annual")
    return "upgrade";
  return planRank(target.planId) > planRank(current.planId)
    ? "upgrade"
    : "scheduled";
}

/** The current period's price after an active percent discount (what was paid). */
export function paidForPeriod(m: {
  amount?: number | null;
  discount?: unknown;
  status?: string | null;
}): number | null {
  if (typeof m.amount !== "number") return null;
  if (m.status === "TRIALING") return 0;
  const d = (m.discount ?? null) as {
    percentOff?: number | null;
    amountOff?: number | null;
    remainingInvoices?: number | null;
  } | null;
  const hasRemaining = d?.remainingInvoices == null || d.remainingInvoices > 0;
  if (d?.amountOff != null && hasRemaining) {
    return Math.max(0, m.amount - d.amountOff);
  }
  const pct = d?.percentOff != null && hasRemaining ? d.percentOff : 0;
  return Math.round(m.amount * (1 - pct / 100));
}

export interface ChangeBreakdown {
  fromPlanName: string;
  toPlanName: string;
  periodStart: string;
  today: string;
  periodEnd: string;
  /** <Plan 1>: <period start> to today (what the time used costs). */
  usedOnCurrent: number;
  /** <Plan 2>: today to <period end> (or the new full period on an interval change). */
  newPlanCharge: number;
  /** Already paid for <Plan 1> this period. */
  alreadyPaid: number;
  /** Discount applied on the invoice (if any). */
  discount: number;
  /** Tax on the invoice (if any). */
  tax: number;
  /** Account credit applied to reduce amount_due. */
  creditUsed: number;
  /** usedOnCurrent + newPlanCharge − alreadyPaid − discount + tax − creditUsed. */
  net: number;
  chargedNow: number;
  creditToBalance: number;
}

/**
 * The breakdown shown in the change dialog, from the provider's proration
 * lines: the unused-time credit (negative proration lines) and the new plan's
 * charge (the positive lines). "Already paid" is the unused credit scaled to the
 * whole period, so used + new − paid equals the provider's net to the cent.
 */
export function changeBreakdown(
  preview: {
    lines: Array<{ amount: number; proration: boolean }>;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    prorationDate: number;
    amountDueNow: number;
    creditToBalance: number;
    discount?: number;
    tax?: number;
    creditUsed?: number;
    alreadyPaid?: number | null;
    unusedCredit?: number;
    newPlanCharge?: number;
  },
  names: { from: string; to: string },
  /** What was paid for the current period, when known (price after an active percent discount). */
  paidForPeriod?: number | null,
): ChangeBreakdown {
  const unused =
    preview.unusedCredit != null
      ? preview.unusedCredit
      : -preview.lines
          .filter((l) => l.proration && l.amount < 0)
          .reduce((a, l) => a + l.amount, 0);
  const newPlanCharge =
    preview.newPlanCharge != null
      ? preview.newPlanCharge
      : preview.lines
          .filter((l) => l.amount > 0)
          .reduce((a, l) => a + l.amount, 0);
  const discount = preview.discount ?? 0;
  const tax = preview.tax ?? 0;
  const creditUsed = preview.creditUsed ?? 0;

  const start = Date.parse(preview.currentPeriodStart);
  const end = Date.parse(preview.currentPeriodEnd);
  const remaining = Math.max(
    1e-9,
    (end - preview.prorationDate) / Math.max(1, end - start),
  );
  const alreadyPaid =
    preview.alreadyPaid != null && preview.alreadyPaid >= unused
      ? preview.alreadyPaid
      : paidForPeriod != null && paidForPeriod >= unused
        ? paidForPeriod
        : Math.round(unused / remaining);
  const usedOnCurrent = alreadyPaid - unused;
  const net =
    usedOnCurrent + newPlanCharge - alreadyPaid - discount + tax - creditUsed;
  return {
    fromPlanName: names.from,
    toPlanName: names.to,
    periodStart: preview.currentPeriodStart,
    today: new Date(preview.prorationDate).toISOString(),
    periodEnd: preview.currentPeriodEnd,
    usedOnCurrent,
    newPlanCharge,
    alreadyPaid,
    discount,
    tax,
    creditUsed,
    net,
    chargedNow: preview.amountDueNow,
    creditToBalance: preview.creditToBalance,
  };
}

@Injectable()
export class BillingService {
  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly access: BillingAccessService,
    private readonly promos: PromoService,
    private readonly subscriptions: SubscriptionsService,
    private readonly clock: AppClock,
    private readonly config: ConfigService,
    private readonly verification: EmailVerificationService,
  ) {}

  private get db() {
    return this.firebase.firestore;
  }

  private get appUrl(): string {
    return String(this.config.get("APP_URL", "http://localhost:3000")).replace(
      /\/$/,
      "",
    );
  }

  private priceRef(planId: string, interval: BillingInterval): PriceRef {
    if (!isPaidPlanId(planId) || planById(planId)?.active === false) {
      throw new BadRequestException({
        statusCode: 400,
        code: "unknown_plan",
        message: "Unknown plan.",
      });
    }
    if (!BILLING_INTERVALS.includes(interval)) {
      throw new BadRequestException({
        statusCode: 400,
        code: "unknown_interval",
        message: "Unknown billing interval.",
      });
    }
    const p = catalogPrice(planId, interval);
    return {
      planId,
      interval,
      amount: p.amount,
      currency: planById(planId).currency,
      lookupKey: p.lookupKey,
    };
  }

  private async mirror(uid: string): Promise<MirrorDoc | null> {
    const snap = await this.db.collection("subscriptions").doc(uid).get();
    return snap.exists ? (snap.data() as MirrorDoc) : null;
  }

  /** The user's live provider subscription, or a 409 explaining why there is none. */
  private async liveSubscription(uid: string): Promise<MirrorDoc> {
    const m = await this.mirror(uid);
    if (
      !m ||
      !m.subscriptionId ||
      m.source === "launch_trial" ||
      !LIVE.includes(m.status) ||
      m.endedAt
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: "no_subscription",
        message: "You don't have a paid subscription to change.",
      });
    }
    return m;
  }

  private async customerId(
    uid: string,
    email: string | null,
    provider: BillingProvider,
  ): Promise<string> {
    // A test-mode customer is never reused in live mode (or the reverse).
    const sameMode = (x: Record<string, unknown>) =>
      x.livemode === undefined || x.livemode === provider.livemode;
    const c = (await this.db.collection("customers").doc(uid).get()).data();
    if (
      c?.customerId &&
      (c.provider == null || c.provider === provider.name) &&
      sameMode(c)
    )
      return String(c.customerId);
    // Reuse the customer from an earlier, unfinished checkout before creating another.
    const pending = await this.db
      .collection("checkout_sessions")
      .where("uid", "==", uid)
      .get();
    const reuse = pending.docs
      .map((d) => d.data())
      .find((s) => s.provider === provider.name && s.customerId && sameMode(s));
    if (reuse) return String(reuse.customerId);
    return (await provider.createCustomer({ uid, email })).customerId;
  }

  /**
   * Free-trial days for this buyer: TRIAL_DAYS, once per person ever — not if
   * the normalised email already had a trial (trial_claims, written by the
   * event handler when a trial starts) or the account has ever paid.
   */
  /** TRIAL_DAYS from the registry; env TRIAL_DAYS overrides it (0 turns trials off). */
  private get trialDays(): number {
    const raw = this.config.get<string | number | undefined>("TRIAL_DAYS");
    const n = raw === undefined || raw === "" ? TRIAL_DAYS : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  async trialDaysFor(uid: string): Promise<number> {
    const days = this.trialDays;
    if (days <= 0) return 0;
    const c = (await this.db.collection("customers").doc(uid).get()).data();
    if (c?.firstPaidAt) return 0;
    let email: string | null = null;
    try {
      email = (await this.firebase.auth.getUser(uid)).email ?? null;
    } catch {
      email = null;
    }
    if (!email) return 0;
    const claim = await this.db.collection("trial_claims").doc(emailHash(email)).get();
    return claim.exists ? 0 : days;
  }

  // ── checkout ──────────────────────────────────────────────────────────

  /**
   * Step 2 summary: subtotal, discount, tax and total from the provider's
   * preview (tax only from the provider), renewal date/price and the consent
   * text to show. A promo that fails validation counts against the promo
   * attempt budget (so this can't be used to guess codes).
   */
  async checkoutPreview(
    uid: string,
    ip: string | null,
    input: {
      planId: string;
      interval: BillingInterval;
      promoCode?: string | null;
      region?: {
        country: string;
        state?: string | null;
        postalCode?: string | null;
      } | null;
    },
  ) {
    const provider = await this.access.requireQuoteProvider();
    const price = this.priceRef(input.planId, input.interval);
    let discount: AppliedDiscount | null = null;
    let promo: { code: string; description: string } | null = null;
    if (input.promoCode) {
      const v = await this.promos.validate({
        code: input.promoCode,
        uid,
        planId: input.planId,
        interval: input.interval,
      });
      if (v.ok === false) {
        await this.promos.consumeAttempt(uid, ip);
        throw new BadRequestException({
          statusCode: 400,
          code: "promo_invalid",
          message: GENERIC_PROMO_ERROR,
        });
      }
      discount = v.discount;
      promo = { code: v.promo.code, description: describePromo(v.promo) };
    }
    const region = input.region
      ? {
          country: input.region.country.toUpperCase(),
          state: input.region.state ? input.region.state.toUpperCase() : null,
          postalCode: input.region.postalCode ?? null,
        }
      : null;
    // Staff preview with no provider connected yet: a local quote (no tax —
    // tax only ever comes from the provider) so steps 1–2 still render.
    const quote = provider
      ? await provider.previewCheckout({ price, discount, region })
      : localQuote(price, discount, this.clock.now());
    const trialDays = await this.trialDaysFor(uid);
    const now = this.clock.now();
    const trialEndsAt = trialDays > 0 ? now + trialDays * 86_400_000 : null;
    // The quote is the first charge; with a trial it happens when the trial ends.
    const firstChargeAt = new Date(trialEndsAt ?? now).toISOString();
    const renewsAt = new Date(
      trialEndsAt ?? addIntervalMs(now, input.interval),
    ).toISOString();
    return {
      planId: price.planId,
      interval: price.interval,
      ...quote,
      promo,
      trial: trialEndsAt
        ? { days: trialDays, endsAt: new Date(trialEndsAt).toISOString() }
        : null,
      /** What is charged today: $0 during a trial, else the quote's total. */
      dueToday: trialEndsAt ? 0 : quote.total,
      firstCharge: { amount: quote.total, at: firstChargeAt },
      renewsAt,
      renewalAmount: price.amount,
      consent: {
        version: CONSENT_VERSION,
        text: consentText(price.planId, price.interval, trialDays),
      },
      refundPolicy: refundPolicy(),
      providerConnected: provider !== null,
    };
  }

  async checkout(
    uid: string,
    email: string | null,
    input: {
      planId: string;
      interval: BillingInterval;
      promoCode?: string | null;
      consent?: { accepted: boolean; version: string } | null;
      marketingOptIn?: boolean;
      billing?: {
        name: string;
        address: {
          line1: string;
          line2?: string | null;
          city: string;
          state?: string | null;
          postalCode?: string | null;
          country: string;
        };
      } | null;
    },
    ip: string | null = null,
  ) {
    const provider = await this.access.requireLive();
    const price = this.priceRef(input.planId, input.interval);
    if (!(await this.verification.isVerified(uid))) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "email_unverified",
        message: "Verify your email address before you buy a plan.",
      });
    }
    if (
      input.consent?.accepted !== true ||
      input.consent.version !== CONSENT_VERSION
    ) {
      throw new BadRequestException({
        statusCode: 400,
        code: "consent_required",
        message: "Please agree to the renewal terms to continue.",
      });
    }
    const billing = normaliseBilling(input.billing);
    const country = billing.address.country;
    const region = {
      country,
      state: billing.address.state,
      postalCode: billing.address.postalCode,
    };
    const m = await this.mirror(uid);
    if (
      m &&
      m.subscriptionId &&
      m.source !== "launch_trial" &&
      LIVE.includes(m.status) &&
      !m.endedAt
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: "already_subscribed",
        message: "You already have a subscription. Change your plan instead.",
      });
    }
    let discount = null;
    let promoId: string | null = null;
    let promoCode: string | null = null;
    if (input.promoCode) {
      const v = await this.promos.validate({
        code: input.promoCode,
        uid,
        planId: input.planId,
        interval: input.interval,
      });
      if (v.ok === false)
        throw new BadRequestException({
          statusCode: 400,
          code: "promo_invalid",
          message: GENERIC_PROMO_ERROR,
        });
      discount = v.discount;
      promoId = v.promo.id;
      promoCode = v.promo.code;
    }
    const customerId = await this.customerId(uid, email, provider);
    // Ask the provider too: our mirror only updates when its webhook arrives,
    // so a second tab could otherwise start a second subscription.
    if (
      provider.liveSubscriptionIds &&
      (await provider.liveSubscriptionIds(customerId)).length > 0
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: "already_subscribed",
        message: "You already have a subscription. Change your plan instead.",
      });
    }
    const day = new Date(this.clock.now()).toISOString().slice(0, 10);
    const idempotencyKey = createHash("sha256")
      .update([uid, price.lookupKey, promoId ?? "", day].join("|"))
      .digest("hex");
    const trialDays = await this.trialDaysFor(uid);
    const session = await provider.createCheckout({
      uid,
      customerId,
      price,
      discount,
      successUrl: `${this.appUrl}/billing/success?session={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${this.appUrl}/manage-plan?checkout=cancelled&plan=${price.planId}&interval=${price.interval}`,
      idempotencyKey,
      billing,
      trialDays,
    });
    // One checkout at a time: an older unpaid one (another tab, another plan) is closed.
    await provider.closeOtherCheckouts?.(customerId, session.id);
    const now = this.clock.nowIso();
    // Region (country/state/ZIP). The full address stays with the provider.
    await this.db
      .collection("customers")
      .doc(uid)
      .set(
        {
          uid,
          livemode: provider.livemode,
          marketingOptIn: { optedIn: input.marketingOptIn === true, at: now },
          billingRegion: region,
        },
        { merge: true },
      );
    await this.db
      .collection("checkout_sessions")
      .doc(session.id)
      .set(
        {
          id: session.id,
          uid,
          provider: provider.name,
          livemode: provider.livemode,
          customerId,
          planId: price.planId,
          interval: price.interval,
          promoId,
          promoCode,
          amountDueToday: session.amountDueToday,
          tax: session.tax ?? 0,
          trialDays,
          region,
          consent: {
            acceptedAt: now,
            version: CONSENT_VERSION,
            text: consentText(price.planId, price.interval, trialDays),
            planId: price.planId,
            interval: price.interval,
            price: price.amount,
            currency: price.currency,
            ip,
          },
          status: session.status,
          createdAt: now,
        },
        { merge: true },
      );
    return {
      sessionId: session.id,
      url: session.url,
      amountDueToday: session.amountDueToday,
      tax: session.tax ?? 0,
      currency: session.currency,
      // Stripe: the browser confirms the first payment with this (Payment Element).
      payment: {
        provider: provider.name,
        clientSecret: session.clientSecret ?? null,
      },
    };
  }

  /** Polled by the success page until the event handler has activated the plan. */
  async checkoutStatus(uid: string, sessionId: string) {
    const snap = await this.db
      .collection("checkout_sessions")
      .doc(sessionId)
      .get();
    if (!snap.exists || snap.data()?.uid !== uid)
      throw new NotFoundException("checkout not found");
    const record = snap.data();
    const effective = await this.subscriptions.forUser(uid);
    return {
      sessionId,
      status: record.status as string,
      planId: record.planId as string,
      interval: record.interval as string,
      active:
        record.status === "complete" && effective.planId === record.planId,
      currentPlan: effective.planId,
    };
  }

  // ── plan changes ──────────────────────────────────────────────────────

  private async assertChangeable(
    uid: string,
    planId: string,
    interval: BillingInterval,
  ) {
    const provider = await this.access.requireLive();
    const m = await this.liveSubscription(uid);
    if (m.status === "PAST_DUE") {
      throw new ConflictException({
        statusCode: 409,
        code: "past_due",
        message:
          "Your last payment failed. Update your card before changing plan.",
      });
    }
    const target = this.priceRef(planId, interval);
    const kind = classifyChange(
      { planId: m.planId, interval: m.interval },
      target,
    );
    if (kind === "same") {
      throw new ConflictException({
        statusCode: 409,
        code: "same_plan",
        message: "You're already on this plan.",
      });
    }
    return { provider, m, target, kind };
  }

  async previewChange(
    uid: string,
    input: { planId: string; interval: BillingInterval },
  ) {
    const { provider, m, target, kind } = await this.assertChangeable(
      uid,
      input.planId,
      input.interval,
    );
    const preview = await provider.previewChange({
      subscriptionId: m.subscriptionId,
      target,
      kind,
    });
    const credit = m.customerId
      ? await provider.getCreditBalance(m.customerId).catch(() => 0)
      : 0;
    const balanceAfter = credit + preview.creditToBalance;
    return {
      ...preview,
      /** When the new plan starts: now, or at the end of the current period for a scheduled change. */
      startsAt:
        kind === "scheduled"
          ? preview.effectiveAt
          : new Date(preview.prorationDate).toISOString(),
      consent: {
        version: CONSENT_VERSION,
        text: consentText(target.planId, target.interval, 0),
      },
      fromPlanId: m.planId,
      fromInterval: m.interval,
      /** In the free trial nothing has been paid: no proration breakdown; the first charge is at trialEndsAt. */
      trialEndsAt: m.status === "TRIALING" ? m.currentPeriodEnd : null,
      breakdown:
        kind === "scheduled" || m.status === "TRIALING"
          ? null
          : changeBreakdown(
              preview,
              {
                from: planById(m.planId)?.name ?? m.planId,
                to: planById(target.planId)?.name ?? target.planId,
              },
              preview.alreadyPaid ?? paidForPeriod(m),
            ),
      creditBalanceAfter: balanceAfter,
      /** The next invoice after the account credit is used. */
      nextInvoiceAfterCredit: Math.max(
        0,
        preview.nextRenewalAmount - balanceAfter,
      ),
      cancelsPendingDowngrade: !!m.scheduledChange && kind !== "scheduled",
      resumesCancelledPlan: m.cancelAtPeriodEnd && kind === "upgrade",
      keepsCancelDate: m.cancelAtPeriodEnd && kind === "downgrade",
    };
  }

  async changePlan(
    uid: string,
    input: {
      planId: string;
      interval: BillingInterval;
      expectedAmountDue?: number | null;
      expectedCredit?: number | null;
      prorationDate?: number | null;
      paymentMethodId?: string | null;
      billing?: BillingInput | null;
      consent?: { accepted: boolean; version: string } | null;
    },
  ) {
    const { provider, m, target, kind } = await this.assertChangeable(
      uid,
      input.planId,
      input.interval,
    );
    if (
      kind === "scheduled" &&
      m.scheduledChange?.planId === target.planId &&
      m.scheduledChange?.interval === target.interval
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: "already_scheduled",
        message: "This change is already scheduled.",
      });
    }
    if (
      (kind === "upgrade" && input.expectedAmountDue == null) ||
      (kind === "downgrade" && input.expectedCredit == null)
    ) {
      throw new BadRequestException({
        statusCode: 400,
        code: "preview_required",
        message: "Preview the change before confirming it.",
      });
    }
    // Every plan change is paid like a first purchase: the card and billing
    // address entered in the payment step, never a card on file. That card
    // pays anything due now and the new plan from its start date.
    let billing: ReturnType<typeof normaliseBilling> | null = null;
    if (provider.name === "stripe") {
      if (!input.paymentMethodId) {
        throw new BadRequestException({
          statusCode: 400,
          code: "payment_method_required",
          message: "Enter your card details to change your plan.",
        });
      }
      billing = normaliseBilling(input.billing);
      if (
        input.consent?.accepted !== true ||
        input.consent.version !== CONSENT_VERSION
      ) {
        throw new BadRequestException({
          statusCode: 400,
          code: "consent_required",
          message: "Please agree to the renewal terms to continue.",
        });
      }
    } else if (input.billing) {
      billing = normaliseBilling(input.billing);
    }
    try {
      const result = await provider.changePlan({
        subscriptionId: m.subscriptionId,
        target,
        kind,
        paymentMethodId: input.paymentMethodId ?? null,
        billing,
        prorationDate: input.prorationDate ?? this.clock.now(),
        expectedAmountDue: kind === "upgrade" ? input.expectedAmountDue : null,
        expectedCredit: kind === "downgrade" ? input.expectedCredit : null,
      });
      if (input.consent?.accepted === true) {
        await this.db.collection("plan_change_consents").doc().set({
          uid,
          from: { planId: m.planId, interval: m.interval },
          to: { planId: target.planId, interval: target.interval },
          kind,
          result: result.status,
          version: CONSENT_VERSION,
          text: consentText(target.planId, target.interval, 0),
          price: target.amount,
          currency: target.currency,
          acceptedAt: this.clock.nowIso(),
          livemode: provider.livemode,
        });
      }
      if (result.status === "payment_failed") {
        throw new HttpException(
          {
            statusCode: 402,
            code: "payment_failed",
            reason: result.reason,
            message: "Your card was declined. Your plan has not changed.",
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
      return { kind, ...result };
    } catch (err) {
      if (err instanceof PreviewStaleError) {
        throw new ConflictException({
          statusCode: 409,
          code: "preview_stale",
          amountDue: err.actual,
          expected: err.expected,
          message: "The price changed since your preview. Review it again.",
        });
      }
      throw err;
    }
  }

  /** "Keep my current plan": drops a scheduled downgrade. */
  async keepCurrentPlan(uid: string) {
    const provider = await this.access.requireLive();
    const m = await this.liveSubscription(uid);
    if (!m.scheduledChange)
      throw new ConflictException({
        statusCode: 409,
        code: "nothing_scheduled",
        message: "No plan change is scheduled.",
      });
    await provider.cancelScheduledChange(m.subscriptionId);
    return { kept: true, planId: m.planId, interval: m.interval };
  }

  async cancel(uid: string) {
    const provider = await this.access.requireLive();
    const m = await this.liveSubscription(uid);
    if (m.cancelAtPeriodEnd)
      return {
        cancelAtPeriodEnd: true,
        endsAt: m.currentPeriodEnd,
        alreadyCancelled: true,
      };
    await provider.cancelAtPeriodEnd(m.subscriptionId);
    return {
      cancelAtPeriodEnd: true,
      endsAt: m.currentPeriodEnd,
      alreadyCancelled: false,
    };
  }

  async resume(uid: string) {
    const provider = await this.access.requireLive();
    const m = await this.liveSubscription(uid);
    if (!m.cancelAtPeriodEnd)
      throw new ConflictException({
        statusCode: 409,
        code: "not_cancelled",
        message: "Your plan is not set to cancel.",
      });
    if (Date.parse(m.currentPeriodEnd) <= this.clock.now()) {
      throw new ConflictException({
        statusCode: 409,
        code: "already_ended",
        message: "This plan has ended. Choose a plan to subscribe again.",
      });
    }
    await provider.resume(m.subscriptionId);
    return { resumed: true, renewsAt: m.currentPeriodEnd };
  }

  // ── billing page ──────────────────────────────────────────────────────

  async summary(uid: string) {
    const live = await this.access.subscriptionsLive();
    const effective = await this.subscriptions.forUser(uid);
    const m = await this.mirror(uid);
    const provider = this.access.configuredProvider;
    let nextCharge: {
      amount: number;
      currency: string;
      date: string;
      discountAmount: number;
      creditApplied: number;
    } | null = null;
    if (
      live &&
      provider &&
      m?.subscriptionId &&
      !m.cancelAtPeriodEnd &&
      LIVE.includes(m.status)
    ) {
      const up = await provider
        .getUpcomingInvoice(m.subscriptionId)
        .catch(() => null);
      if (up)
        nextCharge = {
          amount: up.total,
          currency: up.currency,
          date: up.periodStart,
          discountAmount: up.discountAmount,
          creditApplied: up.creditApplied,
        };
    }
    const d = m?.discount as {
      percentOff?: number;
      amountOff?: number;
      duration?: string;
      durationInMonths?: number;
      endsAt?: string;
      source?: string;
      code?: string;
    } | null;
    return {
      subscriptionsLive: live,
      paidPlansAvailable: live || inCheckoutPreview(),
      checkoutPreview: !live && inCheckoutPreview(),
      provider: this.access.providerName,
      planId: effective.planId,
      planName: effective.planName,
      status: effective.status,
      interval: effective.planId === "none" || !LIVE.includes(m?.status) ? null : (m?.interval ?? null),
      source: m?.source ?? null,
      /** Account credit (downgrades, annual retention) used automatically on the next invoices. */
      creditBalance:
        provider && m?.customerId
          ? await provider.getCreditBalance(m.customerId).catch(() => 0)
          : 0,
      currentPeriodStart: m?.currentPeriodStart ?? null,
      currentPeriodEnd: m?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: m?.cancelAtPeriodEnd === true,
      renewsAt:
        m && !m.cancelAtPeriodEnd && LIVE.includes(m.status)
          ? m.currentPeriodEnd
          : null,
      endsAt: m?.cancelAtPeriodEnd ? m.currentPeriodEnd : null,
      inGrace: effective.inGrace,
      graceEndsAt: effective.graceEndsAt,
      scheduledChange: m?.scheduledChange ?? null,
      discount: d
        ? {
            source: d.source ?? null,
            code: d.code ?? null,
            description: describePromo({
              percentOff: d.percentOff ?? null,
              amountOff: d.amountOff ?? null,
              duration: (d.duration as never) ?? "once",
              durationInMonths: d.durationInMonths ?? null,
            }),
            endsAt: d.endsAt ?? null,
          }
        : null,
      nextCharge,
      hasBillingAccount: !!m?.customerId,
    };
  }

  async invoices(uid: string) {
    const snap = await this.db
      .collection("payments")
      .where("userId", "==", uid)
      .get();
    return snap.docs
      .map((doc) => doc.data())
      .sort((a, b) =>
        String(b.paymentDate).localeCompare(String(a.paymentDate)),
      )
      .map((p) => ({
        id: p.paymentId,
        number: p.invoiceNumber ?? p.paymentId,
        date: p.paymentDate,
        planId: p.planId,
        planName: p.planName,
        interval: p.billingCycle,
        amount: p.amount,
        currency: p.currency,
        discountAmount: p.discountAmount ?? 0,
        creditApplied: p.creditApplied ?? 0,
        amountRefunded: p.amountRefunded ?? 0,
        /** Line items; null for records written before lines were stored (show totals). */
        lines: Array.isArray(p.lines) ? (p.lines as unknown[]) : null,
        status: p.paymentStatus,
        reason: p.billingReason ?? null,
        periodStart: p.subscriptionStartDate,
        periodEnd: p.subscriptionExpiryDate,
        documentPath: `/api/billing/invoices/${encodeURIComponent(String(p.paymentId))}/document`,
        hostedInvoiceUrl: p.hostedInvoiceUrl ?? null,
      }));
  }

  async invoiceDocument(uid: string, invoiceId: string) {
    const row = (
      await this.db.collection("payments").doc(invoiceId).get()
    ).data();
    if (!row || row.userId !== uid)
      throw new NotFoundException("invoice not found");
    const provider = this.access.configuredProvider;
    if (!provider) throw new NotFoundException("invoice not available");
    return provider.getInvoiceDocument(invoiceId);
  }

  async history(uid: string) {
    const snap = await this.db
      .collection("subscription_events")
      .where("uid", "==", uid)
      .get();
    const m = await this.mirror(uid);
    const hasLiveSub = m && m.subscriptionId && LIVE.includes(m.status);

    return snap.docs
      .map((d) => d.data())
      .filter((e) => {
        // Filter out phantom "subscribed" events where subscription was incomplete / NONE or not live
        if (e.type === "subscribed") {
          const to = e.to as Record<string, unknown> | undefined;
          if (to?.status === "NONE" || to?.status === "incomplete") return false;
          if (!hasLiveSub && (!to?.status || to.status === "NONE")) return false;
        }
        return true;
      })
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  /** The plan history page: plan changes, trials, charges, credits and refunds, newest first, with exact timestamps. */
  async timeline(uid: string) {
    const [events, payments] = await Promise.all([
      this.history(uid),
      this.db.collection("payments").where("userId", "==", uid).get(),
    ]);
    return buildTimeline(
      events as Array<Record<string, unknown>>,
      payments.docs.map((d) => d.data()),
    );
  }

  async portal(uid: string) {
    const provider = await this.access.requireLive();
    const c = (await this.db.collection("customers").doc(uid).get()).data();
    if (!c?.customerId)
      throw new ForbiddenException({
        statusCode: 403,
        code: "no_billing_account",
        message: "There is no card on file yet.",
      });
    return provider.createPortalSession({
      customerId: String(c.customerId),
      returnUrl: `${this.appUrl}/manage-plan`,
    });
  }

  async promoPreview(
    uid: string,
    ip: string | null,
    input: { code: string; planId: string; interval: BillingInterval },
  ) {
    await this.access.requireQuoteProvider();
    this.priceRef(input.planId, input.interval);
    return this.promos.preview({ ...input, uid, ip });
  }

  // ── contact ─────────────────────────────────────────────────────────────

  /** The user's own billing contact (backend-only customer record). */
  async contact(uid: string) {
    const c =
      (await this.db.collection("customers").doc(uid).get()).data() ?? {};
    return {
      phone: null,
      marketingOptIn: (c.marketingOptIn as
        { optedIn: boolean; at: string } | undefined) ?? {
        optedIn: false,
        at: null,
      },
    };
  }

  /** Edits product-updates opt-in. */
  async updateContact(
    uid: string,
    input: { marketingOptIn?: boolean },
  ) {
    const ref = this.db.collection("customers").doc(uid);
    const now = this.clock.nowIso();
    const patch: Record<string, unknown> = { uid };
    if (input.marketingOptIn !== undefined)
      patch.marketingOptIn = {
        optedIn: input.marketingOptIn === true,
        at: now,
      };
    await ref.set(patch, { merge: true });
    return this.contact(uid);
  }
}

/** Quote without a provider (staff preview before Stripe keys are set): tax pending. */
export function localQuote(
  price: PriceRef,
  discount: AppliedDiscount | null,
  now: number,
) {
  const d = discount ? normaliseDiscount(discount, price.interval, now) : null;
  const off = discountAmountFor(d, price.amount);
  return {
    currency: price.currency,
    subtotal: price.amount,
    discount: off,
    tax: 0,
    total: price.amount - off,
    taxLabel: null,
    taxPending: true,
  };
}

export interface BillingInput {
  name: string;
  address: {
    line1: string;
    line2?: string | null;
    city: string;
    state?: string | null;
    postalCode?: string | null;
    country: string;
  };
}

/** The billing name and address from the payment step, validated (400 address_invalid otherwise). */
export function normaliseBilling(input: BillingInput | null | undefined) {
  const addr = input?.address;
  const country = String(addr?.country ?? "").toUpperCase();
  const usOk =
    country !== "US" ||
    (!!addr?.state && /^\d{5}(-\d{4})?$/.test(String(addr?.postalCode ?? "")));
  if (
    !input?.name?.trim() ||
    !addr?.line1?.trim() ||
    !addr?.city?.trim() ||
    !/^[A-Z]{2}$/.test(country) ||
    !usOk
  ) {
    throw new BadRequestException({
      statusCode: 400,
      code: "address_invalid",
      message: "Enter your full billing address.",
    });
  }
  return {
    name: input.name.trim(),
    address: {
      line1: addr.line1.trim(),
      line2: addr.line2?.trim() || null,
      city: addr.city.trim(),
      state: addr.state ? addr.state.toUpperCase() : null,
      postalCode: addr.postalCode ?? null,
      country,
    },
  };
}
