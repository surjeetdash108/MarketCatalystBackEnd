import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { AdminAnalyticsService } from "./admin-analytics.service";

/**
 * Admin read-models. Every route is behind AdminGuard — these expose the email
 * address and payment history of every user, so they must never become
 * reachable by an ordinary signed-in account.
 */
@UseGuards(AdminGuard)
@Controller("admin")
export class AdminAnalyticsController {
  constructor(private readonly analytics: AdminAnalyticsService) {}

  @Get("users")
  async users(@Query("limit") limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 500, 1), 2000);
    return { users: await this.analytics.users(n) };
  }

  @Get("subscriptions")
  async subscriptions(@Query("limit") limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
    return { subscriptions: await this.analytics.subscriptionRows(n) };
  }

  @Get("revenue")
  async revenue() {
    return this.analytics.revenue();
  }

  @Get("feature-adoption")
  async featureAdoption() {
    return { adoption: await this.analytics.featureAdoption() };
  }
}
