import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  CATALOG_VERSION,
  DEFAULT_PLAN_ID,
  ENTITLEMENT_KEYS,
  PLAN_DEFINITIONS,
  RETIRED_PLAN_IDS,
  type EntitlementKey,
  type PlanDefinition,
} from "./plans.registry";

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
    // Seeding is the worker's job. PlansModule is also mounted on the public
    // `live` service (so it can serve the admin console) — but that service
    // scales to zero, so seeding there would re-run on every cold start. The
    // worker owns the single seed; live only reads.
    if ((process.env.APP_ROLE ?? "worker").trim().toLowerCase() === "live") {
      return;
    }
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
   * Writes the catalog to the `plans` collection.
   *
   * The registry is the source of truth for prices and grants. A plan document
   * written under an older CATALOG_VERSION (or missing) is rewritten whole, so
   * a deploy is what changes production prices. Within the same version an
   * operator's per-plan entitlement edits (admin console) are kept, new keys
   * are back-filled and retired keys pruned. Retired plan ids are deactivated.
   */
  async seed(): Promise<{
    seeded: number;
    rewritten: string[];
    keysBackfilled: number;
    keysPruned: string[];
    retired: string[];
  }> {
    const col = this.firebase.firestore.collection("plans");
    const validKeys = new Set<string>(ENTITLEMENT_KEYS);
    const now = new Date().toISOString();
    const rewritten: string[] = [];
    const retired: string[] = [];
    const keysPruned = new Set<string>();
    let keysBackfilled = 0;

    for (const def of PLAN_DEFINITIONS) {
      const ref = col.doc(def.id);
      const existing = (await ref.get()).data();
      if (!existing || existing.catalogVersion !== CATALOG_VERSION) {
        await ref.set({
          ...def,
          catalogVersion: CATALOG_VERSION,
          createdAt: (existing?.createdAt as string | undefined) ?? now,
          updatedAt: now,
        });
        rewritten.push(def.id);
        continue;
      }
      const stored = (existing.featureFlags ?? {}) as Record<string, unknown>;
      const featureFlags: Record<string, boolean> = {};
      for (const key of ENTITLEMENT_KEYS) {
        if (typeof stored[key] === "boolean") {
          featureFlags[key] = stored[key];
        } else {
          featureFlags[key] = def.featureFlags[key] === true;
          keysBackfilled++;
        }
      }
      for (const key of Object.keys(stored)) {
        if (!validKeys.has(key)) keysPruned.add(key);
      }
      // Commercial fields always follow the registry; only grants are editable.
      await ref.set({
        ...def,
        featureFlags,
        catalogVersion: CATALOG_VERSION,
        createdAt: (existing.createdAt as string | undefined) ?? now,
        updatedAt: now,
      });
    }

    for (const id of RETIRED_PLAN_IDS) {
      const ref = col.doc(id);
      const snap = await ref.get();
      if (snap.exists && snap.data()?.active !== false) {
        await ref.update({ active: false, retiredAt: now, updatedAt: now });
        retired.push(id);
      }
    }

    this.cache = null;
    this.logger.log(
      `Catalog v${CATALOG_VERSION}: ${PLAN_DEFINITIONS.length} plans ` +
        `(${rewritten.length} rewritten, ${keysBackfilled} keys back-filled, ` +
        `${keysPruned.size} pruned, retired: ${retired.join(",") || "none"})`,
    );
    return {
      seeded: PLAN_DEFINITIONS.length,
      rewritten,
      keysBackfilled,
      keysPruned: [...keysPruned],
      retired,
    };
  }

  /** All plans, newest cache within TTL. Falls back to the registry on error. */
  async list(): Promise<PlanDefinition[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < PlansService.TTL_MS) {
      return this.cache.plans;
    }
    try {
      const snap = await this.firebase.firestore.collection("plans").get();
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

  /** Purchasable/listable plans only — retired plans are excluded. */
  async listActive(): Promise<PlanDefinition[]> {
    return (await this.list()).filter((p) => p.active !== false);
  }

  async get(planId: string): Promise<PlanDefinition | null> {
    const plans = await this.list();
    return plans.find((p) => p.id === planId) ?? null;
  }

  /**
   * Admin edit of a plan's entitlement toggles, from the admin console.
   *
   * New-architecture write path: the browser no longer writes Firestore; the
   * console's per-plan editor calls PATCH /admin/plans/:id and this method does
   * the Firestore write server-side. Only `featureFlags.*` and `updatedAt` are
   * written — never `amount`/`currency`/`billingCycle` (a client able to move
   * price could set a plan to $0), matching the old Firestore-rule constraint.
   *
   * Keys are validated against ENTITLEMENT_KEYS and values coerced to boolean,
   * so a malformed body cannot inject arbitrary fields. Written as dotted paths
   * so only the touched flags change and a concurrent edit to a different flag
   * is preserved.
   */
  async updateFeatureFlags(
    planId: string,
    featureFlags: Record<string, unknown>,
  ): Promise<{ planId: string; updated: string[] }> {
    const allowed = new Set<string>(ENTITLEMENT_KEYS);
    const updates: Record<string, unknown> = {};
    const updated: string[] = [];
    for (const [key, value] of Object.entries(featureFlags ?? {})) {
      if (!allowed.has(key)) continue; // ignore unknown keys rather than write them
      updates[`featureFlags.${key}`] = value === true;
      updated.push(key);
    }
    if (updated.length === 0) {
      throw new Error("No valid entitlement keys to update");
    }
    updates.updatedAt = new Date().toISOString();

    const doc = this.firebase.firestore.collection("plans").doc(planId);
    if (!(await doc.get()).exists) {
      throw new Error(`Plan not found: ${planId}`);
    }
    await doc.update(updates);
    this.cache = null; // force the next list()/get() to re-read the edited plan
    return { planId, updated };
  }

  /**
   * Entitlements granted by a plan. An unknown or inactive plan falls back to
   * the free plan rather than granting nothing — a mis-typed plan id on a user
   * document should degrade to the free tier, not lock them out of the product
   * entirely.
   */
  async entitlementsFor(
    planId: string | null | undefined,
  ): Promise<Record<EntitlementKey, boolean>> {
    const plan =
      (planId ? await this.get(planId) : null) ??
      (await this.get(DEFAULT_PLAN_ID));
    const flags = plan?.featureFlags ?? {};
    return Object.fromEntries(
      ENTITLEMENT_KEYS.map((k) => [k, flags[k] === true]),
    );
  }
}
