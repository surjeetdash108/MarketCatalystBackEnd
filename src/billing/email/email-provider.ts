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
 * Real email can be delivered. Outside production the console sender is fine
 * (dev/staging walkthroughs); in production paid checkout needs real email,
 * because email/password buyers must receive a verification code.
 */
export function emailDeliveryReady(config: ConfigService): boolean {
  return sendGridConfigured(config) || !isProductionProject(config);
}

export function createEmailSender(config: ConfigService): EmailSender {
  if (sendGridConfigured(config))
    return new SendGridEmailSender(
      String(config.get("EMAIL_PROVIDER_API_KEY")),
    );
  if (isProductionProject(config)) {
    new Logger("Email").warn(
      "EMAIL_PROVIDER is not set to sendgrid (or EMAIL_PROVIDER_API_KEY is missing) in production: emails are only logged and paid checkout stays unavailable.",
    );
  }
  return new ConsoleEmailSender();
}

export const emailSenderFactory: FactoryProvider = {
  provide: EMAIL_SENDER,
  inject: [ConfigService],
  useFactory: createEmailSender,
};
