import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { AppClock } from "../../common/app-clock";
import { FirebaseAdminService } from "../../common/firebase-admin.provider";
import { BillingAccessService } from "../billing-access.service";
import { EmailService } from "../email/email.service";
import { emailHash } from "../retention/email-normalise";
import { REFUND_WINDOW_DAYS } from "./refund-policy.config";
import { insideWindow, refundPolicy } from "./refund-policy";

/** Override of REFUND_WINDOW_DAYS for tests only; production reads the config file. */
export const REFUND_WINDOW = Symbol("REFUND_WINDOW");

export type RefundKind = "first_payment" | "annual_renewal";
export type RefundEligibility =
  | {
      eligible: true;
      kind: RefundKind;
      paymentId: string;
      amount: number;
      currency: string;
      refundableUntil: string;
      windowDays: number;
    }
  | { eligible: false; reason: string; windowDays: number };

const DAY = 86_400_000;

/**
 * The refund policy (refund-policy.ts) applied to the user's latest payment.
 * Writes only the once-per-email claim (refund_claims/{sha256(normalised email)});
 * the payment and subscription changes come back as provider events for the
 * event handler — still the only writer of billing state.
 */
@Injectable()
export class RefundService {
  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly access: BillingAccessService,
    private readonly emails: EmailService,
    private readonly clock: AppClock,
    @Optional() @Inject(REFUND_WINDOW) private readonly windowOverride?: number,
  ) {}

  get windowDays(): number {
    return refundPolicy(this.windowOverride ?? REFUND_WINDOW_DAYS).windowDays;
  }

  /** 404 everywhere when refunds are off (REFUND_WINDOW_DAYS = 0). */
  private assertEnabled(): void {
    if (this.windowDays === 0) throw new NotFoundException();
  }

  private get db() {
    return this.firebase.firestore;
  }

  private async email(uid: string): Promise<string | null> {
    try {
      return (await this.firebase.auth.getUser(uid)).email ?? null;
    } catch {
      return null;
    }
  }

  async eligibility(uid: string): Promise<RefundEligibility> {
    this.assertEnabled();
    const days = this.windowDays;
    const provider = this.access.configuredProvider;
    const no = (reason: string): RefundEligibility => ({
      eligible: false,
      reason,
      windowDays: days,
    });
    if (!provider) return no("no_provider");
    const payments = (
      await this.db.collection("payments").where("userId", "==", uid).get()
    ).docs
      .map(
        (d) =>
          ({ id: d.id, ...(d.data() as Record<string, unknown>) }) as Record<
            string,
            unknown
          > & { id: string },
      )
      .filter((p) => p.paymentStatus === "SUCCESS")
      .sort((a, b) =>
        String(b.paymentDate).localeCompare(String(a.paymentDate)),
      );
    const last = payments[0];
    if (!last) return no("no_payment");
    const inv = await provider.getInvoice(String(last.invoiceId ?? last.id));
    if (!inv || !inv.paidAt) return no("no_payment");
    if (inv.amountRefunded > 0) return no("already_refunded");
    const paidAt = Date.parse(inv.paidAt);
    if (!insideWindow(paidAt, this.clock.now(), days))
      return no("outside_window");
    let kind: RefundKind;
    if (inv.billingReason === "subscription_create") {
      const email = await this.email(uid);
      if (!email) return no("no_email");
      if (
        (await this.db.collection("refund_claims").doc(emailHash(email)).get())
          .exists
      )
        return no("already_used");
      kind = "first_payment";
    } else if (
      inv.billingReason === "subscription_cycle" &&
      inv.interval === "annual"
    ) {
      kind = "annual_renewal";
    } else if (inv.billingReason === "subscription_cycle") {
      return no("monthly_renewal");
    } else {
      return no("not_refundable");
    }
    return {
      eligible: true,
      kind,
      paymentId: inv.id,
      amount: inv.amountPaid,
      currency: inv.currency,
      refundableUntil: new Date(paidAt + days * DAY).toISOString(),
      windowDays: days,
    };
  }

  /** User request (Manage Plan) or admin action — same policy either way. */
  async refund(
    uid: string,
    by: "user" | "admin",
  ): Promise<{
    refunded: true;
    amount: number;
    currency: string;
    kind: RefundKind;
  }> {
    const e = await this.eligibility(uid);
    if (e.eligible === false) {
      throw new ConflictException({
        statusCode: 409,
        code: `refund_${e.reason}`,
        message: refundMessage(e.reason, e.windowDays),
      });
    }
    const email = await this.email(uid);
    if (e.kind === "first_payment" && email) {
      // Claim the email first so two clicks (or two accounts) can't both get a first-payment refund.
      const ref = this.db.collection("refund_claims").doc(emailHash(email));
      const claimed = await this.db.runTransaction(async (tx) => {
        if ((await tx.get(ref)).exists) return false;
        tx.set(ref, {
          uid,
          paymentId: e.paymentId,
          amount: e.amount,
          by,
          at: this.clock.nowIso(),
        });
        return true;
      });
      if (!claimed)
        throw new ConflictException({
          statusCode: 409,
          code: "refund_already_used",
          message: refundMessage("already_used", e.windowDays),
        });
    }
    await this.access.configuredProvider!.refund(e.paymentId, e.amount);
    const inv = await this.access.configuredProvider!.getInvoice(e.paymentId);
    await this.emails.refundIssued(email, {
      amount: e.amount,
      currency: e.currency,
      planId: inv?.planId ?? "",
      windowDays: e.windowDays,
    });
    return {
      refunded: true,
      amount: e.amount,
      currency: e.currency,
      kind: e.kind,
    };
  }
}

export function refundMessage(reason: string, days: number): string {
  switch (reason) {
    case "outside_window":
      return `Refunds are available within ${days} days of a payment.`;
    case "already_used":
      return "A first-payment refund has already been used for this email address.";
    case "monthly_renewal":
      return "Monthly renewal payments aren't refundable.";
    case "already_refunded":
      return "This payment has already been refunded.";
    default:
      return "There's no refundable payment on this account.";
  }
}
