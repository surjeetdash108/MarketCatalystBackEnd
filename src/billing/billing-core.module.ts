import { Global, Module } from "@nestjs/common";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { BillingAccessService } from "./billing-access.service";
import { ConsoleEmailSender, EMAIL_SENDER } from "./email/email-sender";
import { EmailService } from "./email/email.service";
import { BILLING_PROVIDER } from "./provider/billing-provider";
import { billingProviderFactory } from "./provider/provider.factory";

/**
 * Provider, access and email — global, because the entitlement guard (used in
 * every module) needs to know whether subscriptions are live.
 */
@Global()
@Module({
  imports: [FeatureFlagsModule],
  providers: [
    billingProviderFactory,
    BillingAccessService,
    { provide: EMAIL_SENDER, useClass: ConsoleEmailSender },
    EmailService,
  ],
  exports: [
    BILLING_PROVIDER,
    BillingAccessService,
    EMAIL_SENDER,
    EmailService,
    FeatureFlagsModule,
  ],
})
export class BillingCoreModule {}
