import {
  CheckoutPreviewInterceptor,
  CheckoutPreviewService,
} from "./checkout-preview";
import { RefundService } from "./refund/refund.service";
import { Module } from "@nestjs/common";
import { PlansModule } from "../plans/plans.module";
import { BillingEventsService } from "./billing-events.service";
import { BillingService } from "./billing.service";
import {
  BillingController,
  BillingWebhookController,
  MeEntitlementsController,
  SignupPromoController,
} from "./billing.controller";
import { FakeBillingController } from "./fake-billing.controller";
import { PromoService } from "./promo/promo.service";
import { RetentionService } from "./retention/retention.service";
import { AdminBillingController } from "./admin-billing.controller";
import { AdminBillingService } from "./admin-billing.service";
import { BillingReconcileJob } from "./reconcile.job";

@Module({
  imports: [PlansModule],
  controllers: [
    BillingController,
    BillingWebhookController,
    SignupPromoController,
    MeEntitlementsController,
    FakeBillingController,
    AdminBillingController,
  ],
  providers: [
    BillingEventsService,
    BillingService,
    PromoService,
    RetentionService,
    AdminBillingService,
    BillingReconcileJob,
    RefundService,
    CheckoutPreviewService,
    CheckoutPreviewInterceptor,
  ],
  exports: [
    BillingEventsService,
    BillingService,
    PromoService,
    RetentionService,
  ],
})
export class BillingModule {}
