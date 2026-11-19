import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { planById } from "../../plans/plans.registry";
import { EMAIL_SENDER, type EmailSender, type EmailTag } from "./email-sender";
import { FirebaseAdminService } from "../../common/firebase-admin.provider";
import {
  escapeHtml,
  noticeRow,
  renderTemplate,
  unsubscribeHtml,
  type TemplateName,
  type TemplateVars,
} from "../../email/email-template";

/** "19 Nov 2027" on the US Eastern calendar (the templates' date style). */
export function shortDate(iso: string | number | Date): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

/** Sender and reply-to for every email (overridable by EMAIL_FROM_ADDRESS / EMAIL_REPLY_TO). */
export const EMAIL_FROM_DEFAULT = "info@marketcatalyst.ai";

/** Formats minor units as "$59.00". */
export function money(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    amount / 100,
  );
}

/** "9 December 2026" (UTC). */
/** A date only (no time), on the US Eastern calendar the trial and intro end dates follow. */
export function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/New_York",
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
    /** For the recipient's first name ("Hi Ana,"); absent in unit tests → "there". */
    @Optional() private readonly firebase?: FirebaseAdminService,
  ) {}

  private get logoUrl(): string {
    return `${this.appUrl}/email/logo.png`;
  }

  /** First word of the account's display name, else "there". */
  private async firstName(to: string): Promise<string> {
    try {
      const u = await this.firebase?.auth.getUserByEmail(to);
      const n = (u?.displayName ?? "").trim().split(/\s+/)[0];
      return n || "there";
    } catch {
      return "there";
    }
  }

  /** Sends a branded template (and a plain-text part) to `to`. */
  private async sendTemplate(
    tag: EmailTag,
    to: string | null | undefined,
    subject: string,
    template: TemplateName,
    vars: TemplateVars,
    text: string[],
    opts: { firstName?: string; unsubscribeUrl?: string | null } = {},
  ): Promise<void> {
    if (!to) {
      this.logger.warn(`[${tag}] skipped: no recipient address`);
      return;
    }
    let html: string;
    try {
      html = renderTemplate(template, {
        logoUrl: this.logoUrl,
        email: to,
        firstName: opts.firstName ?? (await this.firstName(to)),
        unsubscribeHtml: unsubscribeHtml(opts.unsubscribeUrl),
        ...vars,
      });
    } catch (err) {
      this.logger.error(`[${tag}] template failed: ${(err as Error).message}`);
      return;
    }
    try {
      await this.sender.send({
        tag,
        to,
        from: this.from,
        replyTo: this.replyTo,
        subject,
        text: [
          ...text,
          "",
          `Questions? Reply to this email or write to ${this.replyTo}.`,
        ].join("\n"),
        html,
      });
    } catch (err) {
      this.logger.error(`[${tag}] not delivered: ${(err as Error).message}`);
    }
  }

  /** The generic branded layout for a plain email: headline, intro, rows, Manage plan. */
  private async noticeHtml(
    to: string,
    subject: string,
    body: string[],
  ): Promise<string | undefined> {
    try {
      const [intro, ...rest] = body.filter((l) => l.trim());
      const rows = rest.length
        ? rest
        : ["Manage your plan anytime in Manage Plan."];
      return renderTemplate("notice", {
        logoUrl: this.logoUrl,
        subject,
        preheader: intro ?? subject,
        eyebrow: "Your MarketCatalyst plan",
        headlineHtml: escapeHtml(subject),
        introHtml: `Hi ${escapeHtml(await this.firstName(to))}, ${escapeHtml(intro ?? "")}`,
        cardTitle: "Details",
        rowsHtml: rows
          .map((r, i) => noticeRow(escapeHtml(r), i === rows.length - 1))
          .join(""),
        ctaUrl: `${this.appUrl}/manage-plan`,
        ctaLabel: "Manage plan",
        noteHtml: `Questions? Reply to this email or write to <a href="mailto:${escapeHtml(this.replyTo)}" style="color:#1f7a46;text-decoration:underline;">${escapeHtml(this.replyTo)}</a>.`,
        reason:
          "You're receiving this because of a change to your MarketCatalyst plan.",
        unsubscribeHtml: "",
      });
    } catch (err) {
      this.logger.error(`notice template failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  private get from(): string {
    const name = this.config.get<string>("EMAIL_FROM_NAME", "MarketCatalyst"); // prettier-ignore
    const addr = this.config.get<string>("EMAIL_FROM_ADDRESS", EMAIL_FROM_DEFAULT); // prettier-ignore
    return `${name} <${addr}>`;
  }

  private get replyTo(): string {
    return this.config.get<string>("EMAIL_REPLY_TO", EMAIL_FROM_DEFAULT);
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
    html?: string,
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
        html: html ?? (await this.noticeHtml(to, subject, body)),
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
    if (p.planId === "pro" || p.planId === "elite") {
      const annual = p.interval === "annual";
      return this.sendTemplate(
        "welcome",
        to,
        `Welcome to MarketCatalyst ${planName(p.planId)}`,
        p.planId === "pro" ? "pro-confirmed" : "elite-confirmed",
        {
          billing: annual ? "Annual" : "Monthly",
          amount: `${money(p.amount, p.currency)}${p.planId === "elite" ? (annual ? " / year" : " / month") : ""}`,
          card: "Card on file",
          nextBilling: shortDate(p.renewsAt),
        },
        [
          `Your ${planName(p.planId)} plan (${p.interval}) is active.`,
          `You were charged ${money(p.amount, p.currency)}. It renews on ${longDate(p.renewsAt)} unless you cancel.`,
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
  scheduledChangeCancelled(
    to: string,
    p: { planId: string; interval: string; renewsAt: string },
  ) {
    return this.send(
      "change_cancelled",
      to,
      `You're staying on ${planName(p.planId)}`,
      [
        `Your scheduled plan change was cancelled. You stay on ${planName(p.planId)} (${p.interval}).`,
        `Next renewal: ${longDate(p.renewsAt)}.`,
      ],
    );
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
    // Annual plans only: a reminder every month on a monthly plan reads as
    // spam, and the receipt covers each monthly charge.
    if (p.interval !== "annual") {
      this.logger.log(`[renewal_reminder] skipped: ${p.interval} plan`);
      return Promise.resolve();
    }
    if (p.planId === "pro" || p.planId === "elite") {
      return this.sendTemplate(
        "renewal_reminder",
        to,
        `Your ${planName(p.planId)} plan renews in 7 days`,
        p.planId === "pro" ? "pro-renewal-reminder" : "elite-renewal-reminder",
        {
          billing: "Annual",
          amount: money(p.amount, p.currency),
          per: "year",
          renewalDate: shortDate(p.renewsAt),
          monthly: false,
        },
        [
          `Your ${planName(p.planId)} plan renews automatically on ${longDate(p.renewsAt)} for ${money(p.amount, p.currency)}.`,
        ],
      );
    }
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

  /** 6-digit email verification code (branded; the code is never in the subject — senders log subjects). */
  async verificationCode(
    to: string,
    code: string,
    minutes: number,
  ): Promise<void> {
    // Unlike notifications, a failed send must reach the user (they're waiting for the code).
    const html = renderTemplate("verify-email", {
      logoUrl: this.logoUrl,
      email: to,
      firstName: await this.firstName(to),
      unsubscribeHtml: "",
      code,
      minutes: String(minutes),
      verifyUrl: `${this.appUrl}/verify-email`,
    });
    await this.sender.send({
      tag: "verification_code",
      to,
      from: this.from,
      replyTo: this.replyTo,
      subject: "Verify your MarketCatalyst account",
      text: [
        `Your verification code is ${code}.`,
        `It expires in ${minutes} minutes. If you didn't ask for it, ignore this email.`,
      ].join("\n"),
      html,
    });
  }

  /** Account created and verified. */
  accountWelcome(to: string) {
    return this.sendTemplate(
      "account_welcome",
      to,
      "Welcome to MarketCatalyst — Your Market Edge Starts Here",
      "welcome",
      {},
      [
        "Welcome to MarketCatalyst. Your terminal is ready.",
        `Open it: ${this.appUrl}/dashboard`,
      ],
    );
  }

  /** The free week began (new-account intro). */
  trialStarted(to: string, p: { trialEndsAt: string }) {
    return this.sendTemplate(
      "trial_started",
      to,
      "Your MarketCatalyst Starter trial is live",
      "trial-started",
      { trialEnd: shortDate(p.trialEndsAt) },
      [`Your free trial runs until ${longDate(p.trialEndsAt)}.`],
    );
  }

  /** Day-2 onboarding guide (promotional: carries an unsubscribe link). */
  gettingStarted(to: string, p: { unsubscribeUrl: string }) {
    return this.sendTemplate(
      "getting_started",
      to,
      "Getting started with MarketCatalyst: your Dashboard, 15 workspaces and 4 tools",
      "getting-started",
      {},
      [`Your guide to MarketCatalyst: ${this.appUrl}/dashboard`],
      { unsubscribeUrl: p.unsubscribeUrl },
    );
  }

  /** Signed up but hasn't come back within 2 days (promotional). */
  async firstActivation(to: string, p: { unsubscribeUrl: string }) {
    const firstName = await this.firstName(to);
    return this.sendTemplate(
      "first_activation",
      to,
      `${firstName === "there" ? "Your" : `${firstName}, your`} terminal is ready when you are`,
      "first-activation",
      {},
      [`Your MarketCatalyst terminal is ready: ${this.appUrl}/dashboard`],
      { firstName, unsubscribeUrl: p.unsubscribeUrl },
    );
  }

  /** 3 days before the free week ends (promotional). */
  trialEnding(to: string, p: { trialEndsAt: string; unsubscribeUrl: string }) {
    return this.sendTemplate(
      "trial_ending",
      to,
      "Your Starter trial ends in 3 days",
      "trial-ending",
      { trialEnd: shortDate(p.trialEndsAt) },
      [
        `Your free trial ends on ${longDate(p.trialEndsAt)}. Choose a plan: ${this.appUrl}/choose-plan`,
      ],
      { unsubscribeUrl: p.unsubscribeUrl },
    );
  }

  /** The free week is over and no plan was chosen (promotional). */
  trialEnded(to: string, p: { trialEndsAt: string; unsubscribeUrl: string }) {
    return this.sendTemplate(
      "trial_ended",
      to,
      "Your MarketCatalyst trial has ended",
      "trial-ended",
      { trialEnd: shortDate(p.trialEndsAt) },
      [
        `Your free trial ended on ${longDate(p.trialEndsAt)}. Choose a plan: ${this.appUrl}/choose-plan`,
      ],
      { unsubscribeUrl: p.unsubscribeUrl },
    );
  }

  /** Password reset link (Firebase action code, opened on our /auth/action page). */
  passwordReset(to: string, p: { resetUrl: string }) {
    return this.sendTemplate(
      "password_reset",
      to,
      "Reset your MarketCatalyst password",
      "password-reset",
      { resetUrl: p.resetUrl },
      [
        `Reset your password: ${p.resetUrl}`,
        "The link expires in 60 minutes and works once. If you didn't ask for it, ignore this email.",
      ],
    );
  }

  /** A sign-in from a new device or location. */
  loginAlert(
    to: string,
    p: {
      time: string;
      device: string;
      location: string;
      ip: string;
      secureUrl: string;
    },
  ) {
    return this.sendTemplate(
      "login_alert",
      to,
      "New sign-in to your MarketCatalyst account",
      "login-alert",
      p,
      [
        `New sign-in: ${p.time} · ${p.device} · ${p.location} · ${p.ip}.`,
        `If this wasn't you, secure your account: ${p.secureUrl}`,
      ],
    );
  }

  /** Sent after the account is deleted (the name is captured before deletion). */
  accountDeleted(to: string, p: { firstName: string; deletedAt: string }) {
    return this.sendTemplate(
      "account_deleted",
      to,
      "Your MarketCatalyst account has been deleted",
      "account-deleted",
      { date: shortDate(p.deletedAt) },
      [
        `Your MarketCatalyst account was permanently deleted on ${longDate(p.deletedAt)}.`,
      ],
      { firstName: p.firstName },
    );
  }
}
