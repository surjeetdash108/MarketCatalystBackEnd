import {
  Inject,
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
  ) {}

  get providerName(): "fake" | "stripe" | "none" {
    return this.provider?.name ?? "none";
  }

  async flagEnabled(): Promise<boolean> {
    return this.flags.isEnabled(SUBSCRIPTIONS_FLAG);
  }

  /** True when plan gating must be enforced and paid plans can be bought. */
  async subscriptionsLive(): Promise<boolean> {
    return this.provider !== null && (await this.flagEnabled());
  }

  /** 503 "Paid plans launching soon" unless subscriptions are live. */
  async requireLive(): Promise<BillingProvider> {
    if (!(await this.subscriptionsLive())) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: "paid_plans_unavailable",
        message: "Paid plans launching soon.",
      });
    }
    return this.provider;
  }

  /** The provider if one is configured (webhooks still verify when the flag is off). */
  get configuredProvider(): BillingProvider | null {
    return this.provider;
  }
}
