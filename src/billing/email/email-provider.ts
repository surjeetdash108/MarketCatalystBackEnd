import { Logger, type FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isProductionProject } from "../../common/environment";
import {
  ConsoleEmailSender,
  EMAIL_SENDER,
  type EmailSender,
} from "./email-sender";
import { SendGridEmailSender } from "./sendgrid-email-sender";

const usable = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" && !v.includes("PLACEHOLDER");

/** EMAIL_PROVIDER=sendgrid with a usable EMAIL_PROVIDER_API_KEY. */
export function sendGridConfigured(config: ConfigService): boolean {
  return (
    String(config.get("EMAIL_PROVIDER", "") ?? "")
      .trim()
      .toLowerCase() === "sendgrid" &&
    usable(config.get("EMAIL_PROVIDER_API_KEY"))
  );
}

/**
 * Our own (SendGrid) email can be delivered. Informational only: verification
 * uses Firebase's link and Stripe sends receipts/payment emails, so this no
 * longer gates paid checkout.
 */
export function emailDeliveryReady(config: ConfigService): boolean {
  const stripeKey = String(config.get("STRIPE_SECRET_KEY", "") ?? "");
  const isTestStripe = stripeKey.startsWith("sk_test_");
  return sendGridConfigured(config) || !isProductionProject(config) || isTestStripe;
}

export function createEmailSender(config: ConfigService): EmailSender {
  if (sendGridConfigured(config))
    return new SendGridEmailSender(
      String(config.get("EMAIL_PROVIDER_API_KEY")),
    );
  if (isProductionProject(config)) {
    new Logger("Email").warn(
      "EMAIL_PROVIDER is not set to sendgrid (or EMAIL_PROVIDER_API_KEY is missing) in production: our own notification emails are only logged (Stripe sends billing emails; Firebase sends verification links).",
    );
  }
  return new ConsoleEmailSender();
}

export const emailSenderFactory: FactoryProvider = {
  provide: EMAIL_SENDER,
  inject: [ConfigService],
  useFactory: createEmailSender,
};
