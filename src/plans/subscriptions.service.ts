import { Injectable, Optional } from "@nestjs/common";
import { AppClock } from "../common/app-clock";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { PlansService } from "./plans.service";
import {
  DEFAULT_PLAN_ID,
  ENTITLEMENT_KEYS,
  PAST_DUE_GRACE_DAYS,
  type BillingInterval,
  type EntitlementKey,
  type SubscriptionStatus,
  INTRO_DAYS,
  INTRO_GROUPS,
  INTRO_PLAN_ID,
  keysForGroups,
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
    try {
      const authUser = await this.firebase.auth.getUser(userId);
      if (authUser.email && !uData.email) uData.email = authUser.email;
      if (typeof authUser.emailVerified === "boolean") {
        uData.emailVerified = authUser.emailVerified;
      }
      if (authUser.metadata?.creationTime && !uData.createdAt && !uData.accountCreatedAt) {
        uData.accountCreatedAt = new Date(authUser.metadata.creationTime).toISOString();
      }
    } catch {
      /* ignore */
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
    // New account, never subscribed: INTRO_DAYS of the intro feature groups
    // (Market Catalyst), no card — then "Choose a plan".
    if (!mirror && !entitled) {
      let createdMs: number = NaN;
      if (u.createdAt) {
        if (typeof (u.createdAt as { toMillis?: () => number }).toMillis === "function") {
          createdMs = (u.createdAt as { toMillis: () => number }).toMillis();
        } else if (typeof (u.createdAt as { toDate?: () => Date }).toDate === "function") {
          createdMs = (u.createdAt as { toDate: () => Date }).toDate().getTime();
        } else if (typeof u.createdAt === "number") {
          createdMs = u.createdAt;
        } else if (typeof u.createdAt === "string") {
          createdMs = Date.parse(u.createdAt);
        }
      }
      if (Number.isNaN(createdMs) && u.accountCreatedAt) {
        createdMs = Date.parse(String(u.accountCreatedAt));
      }
      const introEnd = createdMs + INTRO_DAYS * DAY;
      // User must verify email (or Google sign-in) to receive 7-day free trial intro access
      const isVerified = u.emailVerified !== false;
      if (Number.isFinite(createdMs) && now < introEnd && isVerified) {
        const intro = new Set(keysForGroups(INTRO_GROUPS));
        return {
          userId,
          planId: INTRO_PLAN_ID,
          planName: "Market Catalyst intro",
          status: "INTRO",
          storedStatus: null,
          interval: null,
          startDate: new Date(createdMs).toISOString(),
          expiryDate: new Date(introEnd).toISOString(),
          cancelAtPeriodEnd: false,
          expiredSinceLastWrite: false,
          daysRemaining: Math.ceil((introEnd - now) / DAY),
          inGrace: false,
          graceEndsAt: null,
          entitled: false,
          entitlements: Object.fromEntries(
            ENTITLEMENT_KEYS.map((k) => [k, intro.has(k)]),
          ) as Record<EntitlementKey, boolean>,
        };
      }
    }
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
