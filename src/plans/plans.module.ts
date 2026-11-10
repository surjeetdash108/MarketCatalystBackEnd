import { Module } from "@nestjs/common";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { PlansController } from "./plans.controller";
import { PlansService } from "./plans.service";
import { SubscriptionsService } from "./subscriptions.service";
import { AdminAnalyticsController } from "./admin-analytics.controller";
import { AdminAnalyticsService } from "./admin-analytics.service";

/**
 * Subscription plans, per-user entitlement resolution, and the admin
 * read-models over users / subscriptions / revenue.
 *
 * Deliberately separate from FeatureFlagsModule: that module answers "is this
 * built and shipped", this one answers "may this tier use it". They are
 * combined only at the controller edge (PlansController), so neither concept
 * leaks into the other's storage.
 */
@Module({
  imports: [FeatureFlagsModule],
  controllers: [PlansController, AdminAnalyticsController],
  providers: [PlansService, SubscriptionsService, AdminAnalyticsService],
  exports: [PlansService, SubscriptionsService],
})
export class PlansModule {}
