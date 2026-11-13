import { ConfigService } from "@nestjs/config";
import { inCheckoutPreview } from "./checkout-preview";
import {
  Inject,
  Optional,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { SUBSCRIPTIONS_FLAG } from "../feature-flags/feature-flags.registry";
import {
  BILLING_PROVIDER,
  type BillingProvider,
} from "./provider/billing-provider";

/**
 * One answer to "are subscriptions live?".
 *
 * - SUBSCRIPTIONS_ENABLED (runtime flag) OFF → nothing is gated, paid flows
 *   say "launching soon", everyone keeps today's access.
 * - No provider configured → paid plans cannot be bought or granted, even if
 *   the flag is on (gating would lock users out of features nobody can buy).
 * - Both present → gating is enforced and paid flows are open.
 */
@Injectable()
export class BillingAccessService {
  constructor(
    private readonly flags: FeatureFlagsService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider | null,
    @Optional() private readonly config?: ConfigService,
  ) {}

  get providerName(): "fake" | "stripe" | "none" {
    return this.provider?.name ?? "none";
  }

  async flagEnabled(): Promise<boolean> {
    return this.flags.isEnabled(SUBSCRIPTIONS_FLAG);
  }

  /** True when plan gating must be enforced and paid plans can be bought. */
  async subscriptionsLive(): Promise<boolean> {
    // Email verification is Firebase's own link and Stripe sends the billing
    // emails, so paid checkout no longer waits on our own email provider.
    return this.provider !== null && (await this.flagEnabled());
  }

  /** Live for everyone, or this request is a staff checkout preview. */
  async paymentsOpen(): Promise<boolean> {
    return inCheckoutPreview() || (await this.subscriptionsLive());
  }

  /**
   * 503 "Paid plans launching soon" unless subscriptions are live — or this is
   * a staff checkout preview (then 503 "Payment provider not connected" until
   * Stripe keys are set).
   */
  async requireLive(): Promise<BillingProvider> {
    if (await this.subscriptionsLive()) return this.provider;
    if (inCheckoutPreview()) {
      if (this.provider) return this.provider;
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: "provider_not_connected",
        message: "Payment provider not connected.",
      });
    }
    throw new ServiceUnavailableException({
      statusCode: 503,
      code: "paid_plans_unavailable",
      message: "Paid plans launching soon.",
    });
  }

  /** For quotes: the provider, or null in a staff preview with no provider yet. */
  async requireQuoteProvider(): Promise<BillingProvider | null> {
    if (inCheckoutPreview() && !this.provider) return null;
    return this.requireLive();
  }

  /** The provider if one is configured (webhooks still verify when the flag is off). */
  get configuredProvider(): BillingProvider | null {
    return this.provider;
  }
}
