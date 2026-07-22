import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { PlansService } from './plans.service';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Read-models for the admin Users / Subscriptions / Revenue screens.
 *
 * Aggregation happens SERVER-side, not in the browser, for two reasons:
 * revenue must not depend on a client correctly summing paise, and the `users`
 * collection is owner-scoped in Firestore rules — a client cannot list it
 * without opening every user's document to every signed-in account.
 */

export interface RevenueSummary {
  currency: string;
  totalMinor: number;
  currentYearMinor: number;
  byPlan: Array<{ planId: string; planName: string; minor: number; payments: number; users: number }>;
  byMonth: Array<{ month: string; minor: number; payments: number }>;
  activeSubscriptions: number;
  expiredSubscriptions: number;
  freeUsers: number;
  /** Customers only — staff accounts are excluded. */
  totalUsers: number;
  /** How many staff rows were filtered out, so the exclusion is auditable. */
  excludedStaff: number;
  paymentsCounted: number;
  /** Currencies present in `payments` other than `currency`, if any. */
  mixedCurrencies: string[];
}

@Injectable()
export class AdminAnalyticsService {
  private readonly logger = new Logger(AdminAnalyticsService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly plans: PlansService,
    private readonly subscriptions: SubscriptionsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Staff accounts, excluded from every figure these read-models produce.
   *
   * The admin is not a customer. Counting it adds a phantom user, shifts the
   * plan mix, drags ARPU down (it pays nothing) and changes the churn
   * denominator — material distortions at this customer count. Reads the same
   * ADMIN_EMAIL as AdminGuard, so "who is staff" has one definition per side.
   */
  private get staffEmails(): Set<string> {
    return new Set([
      this.config.get('ADMIN_EMAIL', 'admin@marketcatalyst.ai').trim().toLowerCase(),
    ]);
  }

  private isStaff(email: unknown): boolean {
    return (
      typeof email === 'string' && this.staffEmails.has(email.trim().toLowerCase())
    );
  }

  /** Users with their effective (expiry-aware) subscription. */
  async users(limit = 500) {
    const snap = await this.firebase.firestore
      .collection('users')
      .limit(limit)
      .get();

    return Promise.all(
      snap.docs
        .filter((d) => !this.isStaff(d.data().email))
        .map(async (d) => {
        const u = d.data();
        const sub = await this.subscriptions.resolve(d.id, u);
        return {
          uid: d.id,
          name: u.name ?? u.displayName ?? null,
          email: u.email ?? null,
          planId: sub.planId,
          planName: sub.planName,
          // The effective status, so a lapsed row reads EXPIRED even though the
          // stored document still says ACTIVE.
          status: sub.status,
          storedStatus: sub.storedStatus,
          expiredSinceLastWrite: sub.expiredSinceLastWrite,
          subscriptionStartDate: sub.startDate,
          subscriptionExpiryDate: sub.expiryDate,
          daysRemaining: sub.daysRemaining,
          joinedDate: u.createdAt ?? null,
          lastLogin: u.lastLoginAt ?? null,
        };
      }),
    );
  }

  /** One row per payment, joined to its user. */
  async subscriptionRows(limit = 1000) {
    const [pay, userSnap] = await Promise.all([
      this.firebase.firestore
        .collection('payments')
        .orderBy('paymentDate', 'desc')
        .limit(limit)
        .get()
        .catch(() => null),
      this.firebase.firestore.collection('users').limit(1000).get(),
    ]);
    const emailByUid = new Map(
      userSnap.docs.map((d) => [d.id, d.data().email ?? d.data().name ?? d.id]),
    );
    if (!pay) return [];
    return pay.docs.map((d) => {
      const p = d.data();
      return {
        paymentId: p.paymentId ?? d.id,
        userId: p.userId ?? null,
        user: emailByUid.get(p.userId) ?? p.userId ?? null,
        planId: p.planId ?? null,
        planName: p.planName ?? null,
        amount: p.amount ?? 0,
        currency: p.currency ?? 'INR',
        paymentStatus: p.paymentStatus ?? null,
        paymentDate: p.paymentDate ?? null,
        subscriptionStartDate: p.subscriptionStartDate ?? null,
        subscriptionExpiryDate: p.subscriptionExpiryDate ?? null,
        billingCycle: p.billingCycle ?? null,
      };
    });
  }

  /**
   * Revenue rolled up from `payments`.
   *
   * Only SUCCESS rows count — refunds and failures must never inflate revenue.
   * Amounts are summed in minor units as integers; converting to rupees before
   * summing would accumulate float error across thousands of rows.
   */
  async revenue(): Promise<RevenueSummary> {
    const [paySnap, userSnap, plans] = await Promise.all([
      this.firebase.firestore.collection('payments').get().catch(() => null),
      this.firebase.firestore.collection('users').get(),
      this.plans.list(),
    ]);

    const planName = new Map(plans.map((p) => [p.id, p.name]));
    const byPlan = new Map<string, { minor: number; payments: number; users: Set<string> }>();
    const byMonth = new Map<string, { minor: number; payments: number }>();
    const currencies = new Set<string>();
    let totalMinor = 0;
    let currentYearMinor = 0;
    let paymentsCounted = 0;

    const thisYear = String(new Date().getUTCFullYear());

    for (const doc of paySnap?.docs ?? []) {
      const p = doc.data();
      if (p.paymentStatus !== 'SUCCESS') continue;
      const amount = typeof p.amount === 'number' ? p.amount : 0;
      const date: string = p.paymentDate ?? '';
      currencies.add(p.currency ?? 'INR');

      totalMinor += amount;
      paymentsCounted++;
      if (date.startsWith(thisYear)) currentYearMinor += amount;

      const pid = p.planId ?? 'unknown';
      const bucket = byPlan.get(pid) ?? { minor: 0, payments: 0, users: new Set<string>() };
      bucket.minor += amount;
      bucket.payments++;
      if (p.userId) bucket.users.add(p.userId);
      byPlan.set(pid, bucket);

      const month = date.slice(0, 7); // YYYY-MM
      if (month) {
        const m = byMonth.get(month) ?? { minor: 0, payments: 0 };
        m.minor += amount;
        m.payments++;
        byMonth.set(month, m);
      }
    }

    // Subscription counts come from users, not payments: a user with no
    // payment row is still a (free) user, and one with several payments is
    // still one subscription.
    let active = 0;
    let expired = 0;
    let free = 0;
    const customerDocs = userSnap.docs.filter((d) => !this.isStaff(d.data().email));
    for (const d of customerDocs) {
      const sub = await this.subscriptions.resolve(d.id, d.data());
      if (sub.status === 'ACTIVE' || sub.status === 'TRIALING') active++;
      else if (sub.status === 'EXPIRED') expired++;
      if (sub.planId === 'free') free++;
    }

    const primary = currencies.size > 0 ? [...currencies][0] : 'INR';
    return {
      currency: primary,
      totalMinor,
      currentYearMinor,
      byPlan: [...byPlan.entries()]
        .map(([planId, v]) => ({
          planId,
          planName: planName.get(planId) ?? planId,
          minor: v.minor,
          payments: v.payments,
          users: v.users.size,
        }))
        .sort((a, b) => b.minor - a.minor),
      byMonth: [...byMonth.entries()]
        .map(([month, v]) => ({ month, ...v }))
        .sort((a, b) => a.month.localeCompare(b.month)),
      activeSubscriptions: active,
      expiredSubscriptions: expired,
      freeUsers: free,
      // Customers only — staff are filtered above, so this will read one lower
      // than the Firebase console's account count. That gap is intentional.
      totalUsers: customerDocs.length,
      excludedStaff: userSnap.size - customerDocs.length,
      paymentsCounted,
      // Summing across currencies would be meaningless; surfaced so the UI can
      // warn rather than silently adding rupees to dollars.
      mixedCurrencies: [...currencies].filter((c) => c !== primary),
    };
  }
}
