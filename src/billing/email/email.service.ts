import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { planById } from "../../plans/plans.registry";
import { EMAIL_SENDER, type EmailSender, type EmailTag } from "./email-sender";

/** Formats minor units as "$59.00". */
export function money(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    amount / 100,
  );
}

/** "9 December 2026" (UTC). */
export function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const planName = (id: string) => planById(id)?.name ?? id;

/**
 * Builds and sends every billing email. Copy is deliberately plain and
 * factual; sender identity and support contact come from config (placeholder
 * values until launch — see docs/PLACEHOLDERS.md).
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    private readonly config: ConfigService,
  ) {}

  private get from(): string {
    const name = this.config.get<string>("EMAIL_FROM_NAME", "MarketCatalyst [PLACEHOLDER]"); // prettier-ignore
    const addr = this.config.get<string>("EMAIL_FROM_ADDRESS", "noreply@example.com"); // prettier-ignore
    return `${name} <${addr}>`;
  }

  private get replyTo(): string {
    return this.config.get<string>("EMAIL_REPLY_TO", "support@example.com");
  }

  private get appUrl(): string {
    return String(this.config.get("APP_URL", "http://localhost:3000")).replace(
      /\/$/,
      "",
    );
  }

  private async send(
    tag: EmailTag,
    to: string | null | undefined,
    subject: string,
    body: string[],
  ): Promise<void> {
    if (!to) {
      this.logger.warn(`[${tag}] skipped: no recipient address`);
      return;
    }
    const text = [
      ...body,
      "",
      `Manage your plan: ${this.appUrl}/manage-plan`,
      `Questions? Reply to this email or write to ${this.replyTo}.`,
    ].join("\n");
    try {
      await this.sender.send({
        tag,
        to,
        from: this.from,
        replyTo: this.replyTo,
        subject,
        text,
      });
    } catch (err) {
      // A failed notification must never undo or block billing state (the
      // event handler would retry the whole event); the sender already logged it.
      this.logger.error(`[${tag}] not delivered: ${(err as Error).message}`);
    }
  }

  welcome(
    to: string,
    p: {
      planId: string;
      interval: string;
      amount: number;
      currency: string;
      renewsAt: string;
      /** Set when the plan starts with a free trial. */
      trialEndsAt?: string | null;
      renewalAmount?: number | null;
    },
  ) {
    if (p.trialEndsAt) {
      return this.send(
        "welcome",
        to,
        `Your ${planName(p.planId)} free trial has started`,
        [
          `Your ${planName(p.planId)} plan (${p.interval}) is active with a free trial until ${longDate(p.trialEndsAt)}. Nothing was charged today.`,
          p.renewalAmount != null
            ? `On ${longDate(p.trialEndsAt)} your card is charged ${money(p.renewalAmount, p.currency)} plus any applicable tax, and the plan renews ${p.interval === "annual" ? "every year" : "every month"} until you cancel.`
            : `Your first charge is on ${longDate(p.trialEndsAt)}.`,
          "Cancel any time before then in Manage Plan and you pay nothing.",
        ],
      );
    }
    return this.send(
      "welcome",
      to,
      `Welcome to MarketCatalyst ${planName(p.planId)}`,
      [
        `Your ${planName(p.planId)} plan (${p.interval}) is active.`,
        `You were charged ${money(p.amount, p.currency)}. It renews on ${longDate(p.renewsAt)} unless you cancel.`,
        "Cancel anytime. You keep access until the end of your billing period.",
      ],
    );
  }

  upgrade(
    to: string,
    p: {
      fromPlanId: string;
      planId: string;
      interval: string;
      charged: number | null;
      currency: string;
      renewsAt: string;
    },
  ) {
    return this.send("upgrade", to, `You're now on ${planName(p.planId)}`, [
      `Your plan changed from ${planName(p.fromPlanId)} to ${planName(p.planId)} (${p.interval}). The new features are available now.`,
      p.charged != null
        ? `Prorated charge today: ${money(p.charged, p.currency)}.`
        : "",
      `Next renewal: ${longDate(p.renewsAt)}.`,
    ]);
  }

  /** Immediate move to a lower plan: features change now; the difference is account credit. */
  downgraded(
    to: string,
    p: {
      fromPlanId: string;
      planId: string;
      interval: string;
      creditBalance: number | null;
      currency: string;
      renewsAt: string;
    },
  ) {
    return this.send("downgraded", to, `You're now on ${planName(p.planId)}`, [
      `Your plan changed from ${planName(p.fromPlanId)} to ${planName(p.planId)} (${p.interval}) today.`,
      `The unused part of ${planName(p.fromPlanId)} was credited to your account and is used automatically on your next invoice(s); it is not refunded to your card.`,
      p.creditBalance != null && p.creditBalance > 0
        ? `Your account credit is now ${money(p.creditBalance, p.currency)}.`
        : "",
      `Next renewal: ${longDate(p.renewsAt)}.`,
    ]);
  }

  /** "Keep my current plan": a scheduled change was cancelled. */
  scheduledChangeCancelled(to: string, p: { planId: string; interval: string; renewsAt: string }) {
    return this.send("change_cancelled", to, `You're staying on ${planName(p.planId)}`, [
      `Your scheduled plan change was cancelled. You stay on ${planName(p.planId)} (${p.interval}).`,
      `Next renewal: ${longDate(p.renewsAt)}.`,
    ]);
  }

  downgradeScheduled(
    to: string,
    p: {
      fromPlanId: string;
      planId: string;
      interval: string;
      effectiveAt: string;
    },
  ) {
    return this.send(
      "downgrade_scheduled",
      to,
      `Your change to ${planName(p.planId)} is scheduled`,
      [
        `You keep ${planName(p.fromPlanId)} until ${longDate(p.effectiveAt)}. From then on you'll be on ${planName(p.planId)} (${p.interval}).`,
        'Changed your mind? Choose "Keep my current plan" on the Manage Plan page before that date.',
      ],
    );
  }

  cancellation(to: string, p: { planId: string; endsAt: string }) {
    return this.send(
      "cancellation",
      to,
      "Your subscription has been cancelled",
      [
        `Your ${planName(p.planId)} plan will not renew. You keep full access until ${longDate(p.endsAt)}, then you can choose a plan any time to keep using MarketCatalyst.`,
        "No further charges will be made. You can resume any time before that date.",
      ],
    );
  }

  resumed(to: string, p: { planId: string; renewsAt: string }) {
    return this.send("resumed", to, "Your subscription will continue", [
      `Your ${planName(p.planId)} plan will renew on ${longDate(p.renewsAt)}.`,
    ]);
  }

  retentionAccepted(
    to: string,
    p: { planId: string; description: string; appliesFrom: string },
  ) {
    return this.send("retention_accepted", to, "Your discount is applied", [
      `Thanks for staying on ${planName(p.planId)}. ${p.description}, starting with the invoice on ${longDate(p.appliesFrom)}.`,
      "Your subscription stays active and nothing else changes.",
    ]);
  }

  paymentFailed(
    to: string,
    p: {
      planId: string;
      amount: number;
      currency: string;
      graceEndsAt: string | null;
    },
  ) {
    return this.send("payment_failed", to, "We couldn't take your payment", [
      `Your payment of ${money(p.amount, p.currency)} for ${planName(p.planId)} failed. We'll retry automatically.`,
      p.graceEndsAt
        ? `You keep access until ${longDate(p.graceEndsAt)} while we retry. Update your card to avoid losing access.`
        : "Update your card to keep your plan.",
    ]);
  }

  actionRequired(
    to: string,
    p: { planId: string; amount: number; currency: string },
  ) {
    return this.send("action_required", to, "Confirm your payment", [
      `Your bank needs you to confirm the payment of ${money(p.amount, p.currency)} for ${planName(p.planId)}.`,
      "Open Manage Plan → Update card to complete it.",
    ]);
  }

  renewalReminder(
    to: string,
    p: {
      planId: string;
      interval: string;
      amount: number;
      currency: string;
      renewsAt: string;
    },
  ) {
    return this.send(
      "renewal_reminder",
      to,
      `Your ${planName(p.planId)} plan renews on ${longDate(p.renewsAt)}`,
      [
        `On ${longDate(p.renewsAt)} we'll charge ${money(p.amount, p.currency)} for another ${p.interval === "annual" ? "year" : "month"} of ${planName(p.planId)}.`,
        "Cancel before then if you don't want to renew. You keep access until the end of your billing period.",
      ],
    );
  }

  priceChange(
    to: string,
    p: {
      planId: string;
      interval: string;
      oldAmount: number;
      newAmount: number;
      currency: string;
      effectiveAt: string;
    },
  ) {
    return this.send(
      "price_change",
      to,
      `A price change for ${planName(p.planId)}`,
      [
        `From ${longDate(p.effectiveAt)}, ${planName(p.planId)} (${p.interval}) will cost ${money(p.newAmount, p.currency)} instead of ${money(p.oldAmount, p.currency)}.`,
        "This notice is sent at least 30 days in advance. You can change or cancel your plan before then.",
      ],
    );
  }

  planEnded(to: string, p: { planId: string }) {
    return this.send("plan_ended", to, "Your plan has ended", [
      `Your ${planName(p.planId)} plan has ended. Your watchlists and data are kept — choose a plan any time to pick up where you left off.`,
    ]);
  }

  receipt(
    to: string,
    p: {
      planId: string;
      amount: number;
      currency: string;
      invoiceNumber: string;
    },
  ) {
    return this.send("receipt", to, `Receipt ${p.invoiceNumber}`, [
      `We received ${money(p.amount, p.currency)} for ${planName(p.planId)}. Thank you.`,
    ]);
  }

  launchOffer(to: string, p: { code: string; trialEndsAt: string }) {
    return this.send("launch_offer", to, "[LAUNCH EMAIL SUBJECT PLACEHOLDER]", [
      "[LAUNCH EMAIL COPY PLACEHOLDER]",
      `You have Pro at no charge until ${longDate(p.trialEndsAt)}. After that, choose a plan to keep using MarketCatalyst.`,
      `Your one-time code for your first year: ${p.code}`,
    ]);
  }

  /** 6-digit email verification code (no billing footer). */
  async verificationCode(
    to: string,
    code: string,
    minutes: number,
  ): Promise<void> {
    await this.sender.send({
      tag: "verification_code",
      to,
      from: this.from,
      replyTo: this.replyTo,
      subject: "Your MarketCatalyst verification code", // never the code: senders log subjects
      text: [
        `Your verification code is ${code}.`,
        `It expires in ${minutes} minutes. If you didn't ask for it, ignore this email.`,
      ].join("\n"),
    });
  }

}
