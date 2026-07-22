import { Injectable, Logger } from '@nestjs/common';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { PlansService } from './plans.service';
import {
  DEFAULT_PLAN_ID,
  ENTITLEMENT_KEYS,
  type EntitlementKey,
  type SubscriptionStatus,
} from './plans.registry';

/**
 * A user's effective subscription and entitlements.
 *
 * Expiry is evaluated HERE rather than trusted from the stored status. A
 * subscription that lapsed overnight still has `subscriptionStatus: "ACTIVE"`
 * on its user document until something rewrites it, and no job runs at the
 * moment a subscription expires — so a stored status alone would keep granting
 * paid access indefinitely. The stored value is treated as intent; the date is
 * treated as truth.
 */

export interface EffectiveSubscription {
  userId: string;
  planId: string;
  planName: string;
  /** Status after applying the expiry date, which may differ from the stored one. */
  status: SubscriptionStatus;
  storedStatus: SubscriptionStatus | null;
  startDate: string | null;
  expiryDate: string | null;
  /** True when a stored ACTIVE has been downgraded here because the date passed. */
  expiredSinceLastWrite: boolean;
  daysRemaining: number | null;
  entitlements: Record<EntitlementKey, boolean>;
}

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly plans: PlansService,
  ) {}

  /** Whole days from now until an ISO date; negative once passed. */
  private daysUntil(iso: string | null): number | null {
    if (!iso) return null;
    const t = Date.parse(iso.length === 10 ? `${iso}T23:59:59Z` : iso);
    if (Number.isNaN(t)) return null;
    return Math.ceil((t - Date.now()) / 86_400_000);
  }

  async forUser(userId: string): Promise<EffectiveSubscription> {
    const snap = await this.firebase.firestore.collection('users').doc(userId).get();
    const u = snap.data() ?? {};
    return this.resolve(userId, u);
  }

  /**
   * Pure resolution from a user document — separated from the read so the admin
   * list can resolve hundreds of users from one query instead of N reads.
   */
  async resolve(userId: string, u: Record<string, any>): Promise<EffectiveSubscription> {
    const storedStatus: SubscriptionStatus | null = u.subscriptionStatus ?? null;
    const expiryDate: string | null = u.subscriptionExpiryDate ?? null;
    const daysRemaining = this.daysUntil(expiryDate);

    // A plan is only honoured while unexpired. TRIALING is treated the same
    // way — a lapsed trial is not a paid subscription.
    const lapsed =
      daysRemaining != null &&
      daysRemaining < 0 &&
      (storedStatus === 'ACTIVE' || storedStatus === 'TRIALING');

    const effectiveStatus: SubscriptionStatus = lapsed
      ? 'EXPIRED'
      : (storedStatus ?? 'NONE');

    const entitled = effectiveStatus === 'ACTIVE' || effectiveStatus === 'TRIALING';
    // Anyone without a live subscription falls back to free — never to "no
    // access", which would lock a lapsed customer out of the product entirely.
    const planId: string = entitled ? (u.currentPlan ?? DEFAULT_PLAN_ID) : DEFAULT_PLAN_ID;

    const planEntitlements = await this.plans.entitlementsFor(planId);
    const plan = await this.plans.get(planId);

    // Per-user overrides layer on top of the plan, enabling comped access or a
    // targeted revocation without inventing a bespoke plan for one account.
    const overrides = (u.featureFlags ?? {}) as Record<string, boolean>;
    const entitlements = Object.fromEntries(
      ENTITLEMENT_KEYS.map((k) => [
        k,
        typeof overrides[k] === 'boolean' ? overrides[k] : planEntitlements[k],
      ]),
    ) as Record<EntitlementKey, boolean>;

    return {
      userId,
      planId,
      planName: plan?.name ?? planId,
      status: effectiveStatus,
      storedStatus,
      startDate: u.subscriptionStartDate ?? null,
      expiryDate,
      expiredSinceLastWrite: lapsed,
      daysRemaining,
      entitlements,
    };
  }
}
