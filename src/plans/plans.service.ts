import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  CATALOG_VERSION,
  DEFAULT_PLAN_ID,
  ENTITLEMENT_KEYS,
  PLAN_DEFINITIONS,
  type EntitlementKey,
  type PlanDefinition,
} from "./plans.registry";
import { applyCatalog, isCatalogApplied } from "./catalog-apply";

/** The registry catalog (what scripts/apply-catalog.ts writes). */
function registryPlans(): PlanDefinition[] {
  return PLAN_DEFINITIONS;
}

/**
 * Reads the `plans` collection.
 *
 * Nothing here writes the catalog: applying a new catalog version to Firestore
 * is an explicit operator step (scripts/apply-catalog.ts, dry-run first, with a
 * backup). Until the stored docs carry the current CATALOG_VERSION, readers get
 * the registry catalog — the exact content the apply would write — so /plans,
 * the website tiles and signup are correct before and after the apply.
 */
@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);
  /** Short cache — plans are read on nearly every entitlement resolution. */
  private cache: { plans: PlanDefinition[]; at: number } | null = null;
  private static readonly TTL_MS = 60_000;
  private warnedStale = false;

  constructor(private readonly firebase: FirebaseAdminService) {}

  /** Dry run of scripts/apply-catalog.ts against this environment (no writes). */
  async previewCatalog() {
    const r = await applyCatalog(this.firebase.firestore, { dryRun: true });
    return {
      catalogVersion: CATALOG_VERSION,
      changes: r.changes,
      applyWith: "scripts/apply-catalog.ts",
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
      const stored = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
      if (!isCatalogApplied(stored)) {
        if (!this.warnedStale) {
          this.warnedStale = true;
          this.logger.warn(
            `plans collection is not on catalog v${CATALOG_VERSION} — serving the registry catalog until scripts/apply-catalog.ts is run`,
          );
        }
        const plans = registryPlans();
        this.cache = { plans, at: now };
        return plans;
      }
      const plans = snap.docs
        .map((d) => ({ ...(d.data() as PlanDefinition), id: d.id }))
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      this.cache = { plans, at: now };
      return plans;
    } catch (err) {
      this.logger.warn(
        `plans read failed, using registry defaults: ${(err as Error).message}`,
      );
      return registryPlans();
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
