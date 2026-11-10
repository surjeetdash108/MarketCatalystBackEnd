import { Logger } from "@nestjs/common";
import type { FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppClock } from "../../common/app-clock";
import { isProductionProject } from "../../common/environment";
import { FirebaseAdminService } from "../../common/firebase-admin.provider";
import { BILLING_PROVIDER, type BillingProvider } from "./billing-provider";
import { FakeBillingProvider } from "./fake/fake-billing.provider";
import { StripeBillingProvider } from "./stripe/stripe-billing.provider";

export type ConfiguredProvider = "fake" | "stripe" | "none";

/** BILLING_PROVIDER env: fake | stripe; anything else (or unset) = none. */
export function configuredProvider(config: ConfigService): ConfiguredProvider {
  const v = String(config.get("BILLING_PROVIDER", "") ?? "")
    .trim()
    .toLowerCase();
  return v === "fake" || v === "stripe" ? v : "none";
}

/** STRIPE_LIVE_APPROVED=true: live-mode Stripe keys may be used. Default off. */
export function stripeLiveApproved(config: ConfigService): boolean {
  return (
    String(config.get("STRIPE_LIVE_APPROVED", "") ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

/**
 * Builds the configured provider, or null when none is configured.
 *
 * SAFETY: the fake provider grants paid plans without payment, so it is
 * refused outright in the production project — the process fails to start
 * rather than run with it. With no provider, paid plans cannot be bought or
 * granted (BillingAccessService reports paid plans unavailable).
 */
export function createBillingProvider(
  config: ConfigService,
  firebase: FirebaseAdminService,
  clock: AppClock,
): BillingProvider | null {
  const name = configuredProvider(config);
  if (name === "fake") {
    if (isProductionProject(config)) {
      throw new Error(
        "FATAL: BILLING_PROVIDER=fake is not allowed in the production project. " +
          "Unset BILLING_PROVIDER (paid plans show 'launching soon') or configure BILLING_PROVIDER=stripe.",
      );
    }
    return new FakeBillingProvider(firebase, clock, {
      appUrl: String(config.get("APP_URL", "http://localhost:3000")).replace(
        /\/$/,
        "",
      ),
      webhookSecret: config.get<string>("FAKE_BILLING_WEBHOOK_SECRET"),
    });
  }
  if (name === "stripe") {
    // No usable key → no provider: paid plans show "launching soon" rather than
    // a checkout that fails. (Keys come from Secret Manager; never logged.)
    const key = String(config.get("STRIPE_SECRET_KEY", "") ?? "");
    if (!/^sk_(test|live)_/.test(key) || key.includes("PLACEHOLDER")) {
      new Logger("BillingProvider").error(
        "BILLING_PROVIDER=stripe but STRIPE_SECRET_KEY is missing or not a Stripe secret key: paid plans stay unavailable.",
      );
      return null;
    }
    // Live keys need an explicit, separate approval; until then only test-mode
    // keys run (the staff checkout preview). Refusing at startup means a live
    // key pasted into the wrong secret can never take real payments.
    if (key.startsWith("sk_live_") && !stripeLiveApproved(config)) {
      throw new Error(
        "FATAL: STRIPE_SECRET_KEY is a live-mode key but STRIPE_LIVE_APPROVED is not 'true'. " +
          "Use a test-mode key (sk_test_…) or set STRIPE_LIVE_APPROVED=true once live payments are approved.",
      );
    }
    return new StripeBillingProvider(config);
  }
  return null;
}

export const billingProviderFactory: FactoryProvider = {
  provide: BILLING_PROVIDER,
  inject: [ConfigService, FirebaseAdminService, AppClock],
  useFactory: createBillingProvider,
};
