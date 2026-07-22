import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { setWithCreatedAt } from '../common/firestore-batch.util';
import {
  DEFAULT_PLAN_ID,
  ENTITLEMENT_KEYS,
  PLAN_DEFINITIONS,
  type EntitlementKey,
  type PlanDefinition,
} from './plans.registry';

/**
 * Reads and seeds the `plans` collection.
 *
 * Firestore is the runtime source of truth so pricing and entitlements change
 * without a redeploy. The registry is only a seed: seeding MERGES, so a plan
 * edited in the console keeps its edits when a later deploy adds a new
 * entitlement key to the registry.
 */
@Injectable()
export class PlansService implements OnModuleInit {
  private readonly logger = new Logger(PlansService.name);
  /** Short cache — plans are read on nearly every entitlement resolution. */
  private cache: { plans: PlanDefinition[]; at: number } | null = null;
  private static readonly TTL_MS = 60_000;

  constructor(private readonly firebase: FirebaseAdminService) {}

  async onModuleInit() {
    // Seed on boot so a fresh environment has plans without a manual step.
    // Failure is logged, not thrown: the app must still start if Firestore is
    // briefly unreachable, and entitlement resolution falls back to the
    // registry anyway.
    try {
      await this.seed();
    } catch (err) {
      this.logger.error(`Plan seeding failed: ${(err as Error).message}`);
    }
  }

  /**
   * Writes each registry plan, preserving any field an operator has changed.
   *
   * New entitlement keys are back-filled onto existing plan documents (missing
   * key → registry default) so adding a module to the registry does not leave
   * older plans with an absent flag, which `resolve()` would otherwise read as
   * "not granted" and silently hide a feature from paying users.
   */
  async seed(): Promise<{
    seeded: number;
    keysBackfilled: number;
    keysPruned: string[];
  }> {
    const col = this.firebase.firestore.collection('plans');
    let keysBackfilled = 0;
    const keysPruned = new Set<string>();
    const validKeys = new Set<string>(ENTITLEMENT_KEYS);

    for (const def of PLAN_DEFINITIONS) {
      const ref = col.doc(def.id);
      const existing = (await ref.get()).data();

      const featureFlags: Record<string, boolean> = { ...def.featureFlags };
      if (existing?.featureFlags) {
        for (const key of ENTITLEMENT_KEYS) {
          if (typeof existing.featureFlags[key] === 'boolean') {
            // Operator's value wins over the registry default.
            featureFlags[key] = existing.featureFlags[key];
          } else {
            keysBackfilled++;
          }
        }
        // Record retired keys so they can be DELETED below. A plain merge can
        // only ever add, so without this a key removed from the registry lives
        // on in Firestore forever — and an older revision booting mid-deploy
        // merges it straight back in. Observed exactly that: `advancedCharts`
        // reappeared on all three plans after being split into finer keys.
        for (const key of Object.keys(existing.featureFlags)) {
          if (!validKeys.has(key)) keysPruned.add(key);
        }
      }

      await setWithCreatedAt(this.firebase.firestore, ref, {
        // Commercial fields are seeded only on first write; afterwards the
        // console is authoritative, or a price edit would be reverted on every
        // deploy.
        ...(existing
          ? {}
          : {
              name: def.name,
              amount: def.amount,
              currency: def.currency,
              billingCycle: def.billingCycle,
              description: def.description,
              active: def.active,
              sortOrder: def.sortOrder,
              stripePriceId: def.stripePriceId,
            }),
        id: def.id,
        featureFlags,
        updatedAt: new Date().toISOString(),
      });
    }

    // Deleting retired keys needs FieldValue.delete() on a dotted path — a
    // merged map write cannot express removal.
    if (keysPruned.size > 0) {
      const { FieldValue } = await import('firebase-admin/firestore');
      const deletes = Object.fromEntries(
        [...keysPruned].map((k) => [`featureFlags.${k}`, FieldValue.delete()]),
      );
      for (const def of PLAN_DEFINITIONS) {
        await col.doc(def.id).update(deletes).catch(() => undefined);
      }
      this.logger.warn(
        `Pruned retired entitlement keys from plans: ${[...keysPruned].join(', ')}`,
      );
    }

    this.cache = null;
    this.logger.log(
      `Seeded ${PLAN_DEFINITIONS.length} plans ` +
        `(${keysBackfilled} keys back-filled, ${keysPruned.size} pruned)`,
    );
    return {
      seeded: PLAN_DEFINITIONS.length,
      keysBackfilled,
      keysPruned: [...keysPruned],
    };
  }

  /** All plans, newest cache within TTL. Falls back to the registry on error. */
  async list(): Promise<PlanDefinition[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < PlansService.TTL_MS) {
      return this.cache.plans;
    }
    try {
      const snap = await this.firebase.firestore.collection('plans').get();
      const plans = snap.docs
        .map((d) => ({ ...(d.data() as PlanDefinition), id: d.id }))
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      if (plans.length > 0) {
        this.cache = { plans, at: now };
        return plans;
      }
      return PLAN_DEFINITIONS;
    } catch (err) {
      this.logger.warn(
        `plans read failed, using registry defaults: ${(err as Error).message}`,
      );
      return PLAN_DEFINITIONS;
    }
  }

  async get(planId: string): Promise<PlanDefinition | null> {
    const plans = await this.list();
    return plans.find((p) => p.id === planId) ?? null;
  }

  /**
   * Entitlements granted by a plan. An unknown or inactive plan falls back to
   * the free plan rather than granting nothing — a mis-typed plan id on a user
   * document should degrade to the free tier, not lock them out of the product
   * entirely.
   */
  async entitlementsFor(planId: string | null | undefined): Promise<Record<EntitlementKey, boolean>> {
    const plan =
      (planId ? await this.get(planId) : null) ?? (await this.get(DEFAULT_PLAN_ID));
    const flags = plan?.featureFlags ?? {};
    return Object.fromEntries(
      ENTITLEMENT_KEYS.map((k) => [k, flags[k] === true]),
    ) as Record<EntitlementKey, boolean>;
  }
}
