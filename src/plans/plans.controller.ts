import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { PlansService } from "./plans.service";
import { SubscriptionsService } from "./subscriptions.service";
import { ENTITLEMENT_KEYS, type EntitlementKey } from "./plans.registry";

/**
 * Which FF_* release flag governs each entitlement.
 *
 * This mapping is what keeps the two axes joined without merging them. An
 * entitlement with no release flag (e.g. `apiAccess`) is considered always
 * released and gated on the plan alone.
 */
const RELEASE_FLAG_FOR: Partial<Record<EntitlementKey, string>> = {
  scanner: "FF_SCREENER",
  screener: "FF_SCREENER",
  watchlist: "FF_WATCHLIST",
  portfolio: "FF_PORTFOLIO",
  marketCatalyst: "FF_DASHBOARD",
  news: "FF_NEWS",
  alerts: "FF_ALERTS",
  advancedCharts: "FF_STOCKDETAIL",
  technicalRatings: "FF_STOCKDETAIL",
  fundamentalRatings: "FF_EPSHIST",
  aiAssistant: "FF_AI_MISC",
  // backtesting / paperTrading have no release flag yet — they are unbuilt, so
  // they are listed in UNBUILT below rather than mapped to an unrelated flag.
};

/**
 * Modules that do not exist yet. Reported as released:false regardless of
 * plan, so the UI says "coming soon" instead of "upgrade to unlock" — charging
 * for something unbuilt is the failure mode this list prevents.
 */
const UNBUILT: EntitlementKey[] = ["backtesting", "paperTrading"];

export interface ResolvedEntitlement {
  key: EntitlementKey;
  /** Built and switched on for everyone (FF_* layer). */
  released: boolean;
  /** Included in this user's plan (commercial layer). */
  entitled: boolean;
  /** released && entitled — the only field the UI should gate rendering on. */
  enabled: boolean;
  /** Why it is off, so the UI can choose the right message. */
  reason: "ok" | "not-released" | "not-in-plan" | "both";
}

@Controller()
export class PlansController {
  private readonly logger = new Logger(PlansController.name);

  constructor(
    private readonly plans: PlansService,
    private readonly subscriptions: SubscriptionsService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /** Public pricing table. Amounts are MINOR units (cents), matching Stripe. */
  @Get("plans")
  async listPlans() {
    return { plans: await this.plans.list() };
  }

  @UseGuards(AdminGuard)
  @Post("plans/seed")
  async seed() {
    return this.plans.seed();
  }

  /**
   * PATCH /admin/plans/:id — admin console's per-plan entitlement editor.
   *
   * The browser used to write `plans/{id}.featureFlags` directly; under the
   * new architecture that write lives here (UI → backend → Firebase). AdminGuard
   * gates it, and the service only ever writes `featureFlags.*` + `updatedAt`,
   * so price/currency/cycle can never be changed through this route.
   */
  @UseGuards(AdminGuard)
  @Patch("api/admin/plans/:id")
  async updatePlan(
    @Param("id") id: string,
    @Body() body: { featureFlags?: Record<string, unknown> },
  ) {
    const featureFlags = body?.featureFlags;
    if (!featureFlags || typeof featureFlags !== "object") {
      throw new BadRequestException("body.featureFlags (object) is required");
    }
    try {
      return await this.plans.updateFeatureFlags(id, featureFlags);
    } catch (err) {
      const message = (err as Error).message;
      if (message.startsWith("Plan not found")) {
        throw new NotFoundException(message);
      }
      throw new BadRequestException(message);
    }
  }

  /**
   * GET /users/:uid/entitlements — the combined answer the client renders from.
   *
   * Guarded: a user must not be able to read another user's subscription. The
   * AdminGuard admits the admin account; per-user self-service reads arrive
   * once the Hosting rewrite lands and requests carry a Firebase ID token
   * (see Doc/POLYGON-FEATURE-CROSSCHECK.md §2.2).
   */
  @UseGuards(AdminGuard)
  @Get("users/:uid/entitlements")
  async entitlements(@Param("uid") uid: string) {
    const [sub, flagMap] = await Promise.all([
      this.subscriptions.forUser(uid),
      this.flags.getMap(),
    ]);

    const resolved: ResolvedEntitlement[] = ENTITLEMENT_KEYS.map((key) => {
      const flagKey = RELEASE_FLAG_FOR[key];
      const released = UNBUILT.includes(key)
        ? false
        : flagKey
          ? flagMap[flagKey] === true
          : true;
      const entitled = sub.entitlements[key] === true;
      const reason: ResolvedEntitlement["reason"] =
        released && entitled
          ? "ok"
          : !released && !entitled
            ? "both"
            : released
              ? "not-in-plan"
              : "not-released";
      return { key, released, entitled, enabled: released && entitled, reason };
    });

    return {
      subscription: sub,
      entitlements: resolved,
      // Flat map for the common `enabled?` check without walking the array.
      enabled: Object.fromEntries(resolved.map((r) => [r.key, r.enabled])),
    };
  }
}
