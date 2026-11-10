import { Logger } from "@nestjs/common";
import { maskEmail, type EmailMessage, type EmailSender } from "./email-sender";

/**
 * Twilio SendGrid adapter (EMAIL_PROVIDER=sendgrid), over the v3 Mail Send
 * API — no SDK. The API key comes from EMAIL_PROVIDER_API_KEY (Secret Manager)
 * and is never logged; addresses are logged masked.
 *
 * Retries 429 / 5xx / network errors with backoff (3 attempts); other 4xx
 * fail at once (they won't succeed on retry). Throws SendGridError when it
 * gives up, so callers decide whether a failure matters.
 */
export const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

export class SendGridError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/** "Name <addr@x>" → { name, email }. */
export function parseAddress(v: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(v);
  return m
    ? { email: m[2].trim(), ...(m[1] ? { name: m[1] } : {}) }
    : { email: v.trim() };
}

export class SendGridEmailSender implements EmailSender {
  private readonly logger = new Logger("Email");

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly opts: { attempts?: number; backoffMs?: number } = {},
  ) {
    if (!apiKey) throw new Error("SendGrid API key is not configured");
  }

  async send(message: EmailMessage): Promise<void> {
    const body = JSON.stringify({
      personalizations: [{ to: [{ email: message.to }] }],
      from: parseAddress(message.from),
      reply_to: parseAddress(message.replyTo),
      subject: message.subject,
      content: [{ type: "text/plain", value: message.text }],
      categories: [message.tag],
      tracking_settings: {
        click_tracking: { enable: false },
        open_tracking: { enable: false },
      },
    });
    const attempts = this.opts.attempts ?? 3;
    const backoff = this.opts.backoffMs ?? 500;
    let last: SendGridError | null = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        const r = await this.fetchImpl(SENDGRID_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body,
        });
        if (r.status >= 200 && r.status < 300) {
          this.logger.log(
            `[${message.tag}] sent via SendGrid to=${maskEmail(message.to)}`,
          );
          return;
        }
        // The response body never contains our key; keep only a short excerpt.
        const detail = (await r.text().catch(() => ""))
          .slice(0, 200)
          .replace(/\s+/g, " ");
        last = new SendGridError(r.status, `SendGrid ${r.status}: ${detail}`);
        if (r.status !== 429 && r.status < 500) break;
      } catch (err) {
        last = new SendGridError(
          null,
          `SendGrid network error: ${(err as Error).message}`,
        );
      }
      if (i < attempts)
        await new Promise((res) => setTimeout(res, backoff * 3 ** (i - 1)));
    }
    this.logger.error(
      `[${message.tag}] SendGrid failed to=${maskEmail(message.to)}: ${last?.message ?? "unknown"}`,
    );
    throw last ?? new SendGridError(null, "SendGrid failed");
  }
}
