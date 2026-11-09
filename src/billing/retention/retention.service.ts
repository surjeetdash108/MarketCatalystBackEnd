import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { AppClock } from "../../common/app-clock";
import { FirebaseAdminService } from "../../common/firebase-admin.provider";
import { catalogPrice, type BillingInterval } from "../../plans/plans.registry";
import { BillingAccessService } from "../billing-access.service";
import type { MirrorDoc } from "../billing-events.service";
import { EmailService, longDate, money } from "../email/email.service";
import {
  BILLING_PROVIDER,
  type BillingProvider,
} from "../provider/billing-provider";
import { emailHash } from "./email-normalise";

/**
 * The retention offer shown in front of Cancel (decision b).
 *
 *   monthly: 50% off the next 2 invoices (Stripe: RETAIN50_2M coupon)
 *   annual:  credit = annual price ÷ 12 × 2 × 50% on the next invoice
 *            (Stripe: customer balance credit)
 *
 * Once per email address, ever: acceptance is recorded in
 * retention_offers/{sha256(normalised email)} — which survives account
 * deletion and re-signup — and in the provider customer's metadata. The offer
 * is also skipped while a discount of 50% or more is active, and it replaces
 * (never stacks with) a weaker promo discount.
 */

export const RETENTION_PERCENT = 50;
export const RETENTION_MONTHS = 2;

export type RetentionIneligibility =
  | "subscriptions_unavailable"
  | "no_paid_subscription"
  | "no_email"
  | "already_used"
  | "discount_already_50";

export interface RetentionOffer {
  mode: "percent_next_invoices" | "balance_credit";
  percentOff: number;
  months: number;
  interval: BillingInterval;
  /** Annual only: the credit, minor units. */
  creditAmount: number | null;
  currency: string;
  /** When the discount first applies (next invoice). */
  appliesFrom: string;
  headline: string;
  description: string;
}

export function retentionCredit(
  planId: string,
  currency = "USD",
): { amount: number; currency: string } {
  const annual = catalogPrice(planId, "annual");
  return {
    amount: Math.round(
      ((annual?.amount ?? 0) / 12) *
        RETENTION_MONTHS *
        (RETENTION_PERCENT / 100),
    ),
    currency,
  };
}

@Injectable()
export class RetentionService {
  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly access: BillingAccessService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider | null,
    private readonly emails: EmailService,
    private readonly clock: AppClock,
  ) {}

  private async mirror(uid: string): Promise<MirrorDoc | null> {
    const snap = await this.firebase.firestore
      .collection("subscriptions")
      .doc(uid)
      .get();
    return snap.exists ? (snap.data() as MirrorDoc) : null;
  }

  private async email(uid: string): Promise<string | null> {
    const c = (
      await this.firebase.firestore.collection("customers").doc(uid).get()
    ).data();
    if (c?.email) return String(c.email);
    try {
      return (await this.firebase.auth.getUser(uid)).email ?? null;
    } catch {
      return null;
    }
  }

  async offerFor(
    uid: string,
  ): Promise<
    | { eligible: true; offer: RetentionOffer }
    | { eligible: false; reason: RetentionIneligibility }
  > {
    if (!(await this.access.subscriptionsLive()))
      return { eligible: false, reason: "subscriptions_unavailable" };
    const m = await this.mirror(uid);
    if (
      !m ||
      !m.subscriptionId ||
      m.source === "launch_trial" ||
      !["ACTIVE", "TRIALING"].includes(m.status)
    ) {
      return { eligible: false, reason: "no_paid_subscription" };
    }
    const email = await this.email(uid);
    if (!email) return { eligible: false, reason: "no_email" };
    const used = await this.firebase.firestore
      .collection("retention_offers")
      .doc(emailHash(email))
      .get();
    if (used.exists) return { eligible: false, reason: "already_used" };
    const d = m.discount as {
      percentOff?: number | null;
      amountOff?: number | null;
      remainingInvoices?: number | null;
    } | null;
    const activeDiscount =
      d && (d.remainingInvoices == null || d.remainingInvoices > 0);
    if (activeDiscount) {
      const pct =
        d.percentOff ?? ((d.amountOff ?? 0) / Math.max(1, m.amount ?? 1)) * 100;
      if (pct >= RETENTION_PERCENT)
        return { eligible: false, reason: "discount_already_50" };
    }
    const interval = m.interval ?? "monthly";
    const appliesFrom = m.currentPeriodEnd;
    if (interval === "annual") {
      const credit = retentionCredit(m.planId, m.currency ?? "USD");
      return {
        eligible: true,
        offer: {
          mode: "balance_credit",
          percentOff: RETENTION_PERCENT,
          months: RETENTION_MONTHS,
          interval,
          creditAmount: credit.amount,
          currency: credit.currency,
          appliesFrom,
          headline: `Before you go: ${RETENTION_PERCENT}% off for the next ${RETENTION_MONTHS} months. Still want to cancel?`,
          description: `A credit of ${money(credit.amount, credit.currency)} (${RETENTION_PERCENT}% of two months) comes off your next renewal on ${longDate(appliesFrom)}`,
        },
      };
    }
    return {
      eligible: true,
      offer: {
        mode: "percent_next_invoices",
        percentOff: RETENTION_PERCENT,
        months: RETENTION_MONTHS,
        interval,
        creditAmount: null,
        currency: m.currency ?? "USD",
        appliesFrom,
        headline: `Before you go: ${RETENTION_PERCENT}% off for the next ${RETENTION_MONTHS} months. Still want to cancel?`,
        description: `${RETENTION_PERCENT}% off your next ${RETENTION_MONTHS} monthly invoices`,
      },
    };
  }

  async accept(
    uid: string,
  ): Promise<{ applied: true; description: string; appliesFrom: string }> {
    const result = await this.offerFor(uid);
    if (result.eligible === false) {
      throw new ConflictException({
        statusCode: 409,
        code: "retention_unavailable",
        reason: result.reason,
        message: "This offer is not available.",
      });
    }
    const m = await this.mirror(uid);
    const email = await this.email(uid);
    const hash = emailHash(email);
    const ref = this.firebase.firestore
      .collection("retention_offers")
      .doc(hash);
    // Claim the email first so two clicks cannot both apply it.
    const claimed = await this.firebase.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, {
        emailHash: hash,
        uid,
        planId: m.planId,
        interval: m.interval,
        mode: result.offer.mode,
        acceptedAt: this.clock.nowIso(),
        subscriptionId: m.subscriptionId,
        provider: this.provider?.name ?? null,
      });
      return true;
    });
    if (!claimed)
      throw new ConflictException({
        statusCode: 409,
        code: "retention_unavailable",
        reason: "already_used",
        message: "This offer is not available.",
      });

    const provider = await this.access.requireLive();
    const offer = result.offer;
    await (offer.mode === "balance_credit"
      ? provider.applyRetentionDiscount({
          subscriptionId: m.subscriptionId,
          customerId: m.customerId,
          mode: "balance_credit",
          amount: offer.creditAmount,
          currency: offer.currency,
        })
      : provider.applyRetentionDiscount({
          subscriptionId: m.subscriptionId,
          customerId: m.customerId,
          mode: "percent_next_invoices",
          percentOff: offer.percentOff,
          invoices: offer.months,
        }));
    await provider.setCustomerMetadata(m.customerId, {
      retention_offer_used: "true",
      retention_email_hash: hash,
      retention_accepted_at: this.clock.nowIso(),
    });
    await this.emails.retentionAccepted(email, {
      planId: m.planId,
      description: offer.description,
      appliesFrom: offer.appliesFrom,
    });
    return {
      applied: true,
      description: offer.description,
      appliesFrom: offer.appliesFrom,
    };
  }
}
