import { Injectable, Logger } from "@nestjs/common";

/** Every transactional email the app sends (doc Step 3, Emails table). */
export type EmailTag =
  | "welcome"
  | "upgrade"
  | "downgrade_scheduled"
  | "cancellation"
  | "resumed"
  | "retention_accepted"
  | "payment_failed"
  | "action_required"
  | "renewal_reminder"
  | "price_change"
  | "plan_ended"
  | "receipt"
  | "launch_offer"
  | "verification_code"
  | "refund";

export interface EmailMessage {
  tag: EmailTag;
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  text: string;
}

/** Where email goes. The real provider (SendGrid, Postmark, …) is a later config choice. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

/** a***@example.com — addresses are never logged in full. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Console/log adapter: logs tag, masked recipient and subject (never the full
 * address or body) and keeps the last 200 messages in memory so tests and the
 * dev walkthrough can inspect what would have been sent.
 */
@Injectable()
export class ConsoleEmailSender implements EmailSender {
  private readonly logger = new Logger("Email");
  readonly outbox: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.outbox.push(message);
    if (this.outbox.length > 200) this.outbox.shift();
    this.logger.log(
      `[${message.tag}] to=${maskEmail(message.to)} subject="${message.subject}"`,
    );
    return Promise.resolve();
  }
}
