import { Injectable, Optional } from "@nestjs/common";
import { AppClock } from "../common/app-clock";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { PlansService } from "./plans.service";
import { isLifetimeElite } from "./lifetime-elite";
import {
  DEFAULT_PLAN_ID,
  ENTITLEMENT_KEYS,
  PAST_DUE_GRACE_DAYS,
  type BillingInterval,
  type EntitlementKey,
  type SubscriptionStatus,
} from "./plans.registry";

/**
 * A user's effective subscription and entitlements.
 *
 * Source of truth: `subscriptions/{uid}`, the backend-only mirror written by
 * the billing event handler (and the launch-trial grant). Plan fields on the
 * user document are a display projection and are never trusted here.
 *
 * The stored status is intent; the dates decide:
 *   ACTIVE     entitled until currentPeriodEnd + a renewal leeway (a renewal
 *              event can arrive a little after the period boundary)
 *   TRIALING   entitled until currentPeriodEnd, exactly
 *   PAST_DUE   entitled for PAST_DUE_GRACE_DAYS after the failed payment
 *   otherwise  no plan (NO_PLAN_ID): sign-in, account, Manage Plan, checkout only
 */

/** How long after period end an ACTIVE mirror is still honoured, waiting for the renewal event. */
export const RENEWAL_LEEWAY_MS = 2 * 86_400_000;
const DAY = 86_400_000;

export interface SubscriptionMirror {
  uid: string;
  planId: string;
  interval?: BillingInterval | null;
  status: SubscriptionStatus;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  pastDueSince?: string | null;
  startedAt?: string | null;
  source?: "provider" | "launch_trial";
}

export interface EffectiveSubscription {
  userId: string;
  planId: string;
  planName: string;
  /** Status after applying dates and grace, which may differ from the stored one. */
  status: SubscriptionStatus;
  storedStatus: SubscriptionStatus | null;
  interval: BillingInterval | null;
  startDate: string | null;
  expiryDate: string | null;
  cancelAtPeriodEnd: boolean;
  /** True when a stored ACTIVE/TRIALING/PAST_DUE was downgraded here by its dates. */
  expiredSinceLastWrite: boolean;
  daysRemaining: number | null;
  inGrace: boolean;
  graceEndsAt: string | null;
  entitled: boolean;
  entitlements: Record<EntitlementKey, boolean>;
}

@Injectable()
export class SubscriptionsService {
  private readonly clock: AppClock;

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly plans: PlansService,
    @Optional() clock?: AppClock,
  ) {
    this.clock = clock ?? new AppClock();
  }

  async forUser(userId: string): Promise<EffectiveSubscription> {
    const [mirrorSnap, userSnap] = await Promise.all([
      this.firebase.firestore.collection("subscriptions").doc(userId).get(),
      this.firebase.firestore.collection("users").doc(userId).get(),
    ]);
    const uData = (userSnap.data() ?? {}) as Record<string, unknown>;
    if (!uData.email) {
      try {
        const authUser = await this.firebase.auth.getUser(userId);
        if (authUser.email) uData.email = authUser.email;
      } catch {
        /* ignore */
      }
    }
    return this.resolve(
      userId,
      uData,
      (mirrorSnap.exists
        ? mirrorSnap.data()
        : null) as SubscriptionMirror | null,
    );
  }

  /**
   * Pure resolution — the admin list resolves many users from one query.
   * `u` (the user document) contributes only admin-set per-user overrides.
   */
  async resolve(
    userId: string,
    u: Record<string, unknown>,
    mirror: SubscriptionMirror | null = null,
  ): Promise<EffectiveSubscription> {
    if (isLifetimeElite((u.email as string) ?? null)) {
      const plan = await this.plans.get("elite");
      return {
        userId,
        planId: "elite",
        planName: plan?.name ?? "Elite",
        status: "ACTIVE",
        storedStatus: "ACTIVE",
        interval: mirror?.interval ?? "annual",
        startDate: mirror?.startedAt ?? mirror?.currentPeriodStart ?? null,
        expiryDate: null,
        cancelAtPeriodEnd: false,
        expiredSinceLastWrite: false,
        daysRemaining: null,
        inGrace: false,
        graceEndsAt: null,
        entitled: true,
        entitlements: Object.fromEntries(
          ENTITLEMENT_KEYS.map((k) => [k, true]),
        ) as Record<EntitlementKey, boolean>,
      };
    }

    const now = this.clock.now();
    const storedStatus: SubscriptionStatus | null = mirror?.status ?? null;
    const end = mirror?.currentPeriodEnd
      ? Date.parse(mirror.currentPeriodEnd)
      : NaN;
    let entitled = false;
    let inGrace = false;
    let graceEndsAt: string | null = null;
    let lapsed = false;

    if (storedStatus === "ACTIVE") {
      entitled = Number.isNaN(end) || now <= end + RENEWAL_LEEWAY_MS;
      lapsed = !entitled;
    } else if (storedStatus === "TRIALING") {
      entitled = !Number.isNaN(end) && now <= end;
      lapsed = !entitled;
    } else if (storedStatus === "PAST_DUE") {
      const since = mirror?.pastDueSince
        ? Date.parse(mirror.pastDueSince)
        : NaN;
      const graceEnd = Number.isNaN(since)
        ? NaN
        : since + PAST_DUE_GRACE_DAYS * DAY;
      graceEndsAt = Number.isNaN(graceEnd)
        ? null
        : new Date(graceEnd).toISOString();
      entitled = !Number.isNaN(graceEnd) && now < graceEnd;
      inGrace = entitled;
      lapsed = !entitled;
    }

    const effectiveStatus: SubscriptionStatus = lapsed
      ? "EXPIRED"
      : (storedStatus ?? "NONE");
    const planId = entitled && mirror?.planId ? mirror.planId : DEFAULT_PLAN_ID;
    const planEntitlements = await this.plans.entitlementsFor(planId);
    const plan = await this.plans.get(planId);

    // Admin-set per-user overrides (comped access, targeted revocation). The
    // user document is not client-writable for this field (firestore.rules).
    const overrides = (u.featureFlags ?? {}) as Record<string, boolean>;
    const entitlements = Object.fromEntries(
      ENTITLEMENT_KEYS.map((k) => [
        k,
        typeof overrides[k] === "boolean" ? overrides[k] : planEntitlements[k],
      ]),
    ) as Record<EntitlementKey, boolean>;

    return {
      userId,
      planId,
      planName: plan?.name ?? planId,
      status: effectiveStatus,
      storedStatus,
      interval: mirror?.interval ?? null,
      startDate: mirror?.startedAt ?? mirror?.currentPeriodStart ?? null,
      expiryDate: mirror?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: mirror?.cancelAtPeriodEnd === true,
      expiredSinceLastWrite: lapsed,
      daysRemaining: Number.isNaN(end) ? null : Math.ceil((end - now) / DAY),
      inGrace,
      graceEndsAt,
      entitled,
      entitlements,
    };
  }
}
