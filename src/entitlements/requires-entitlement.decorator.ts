import { applyDecorators, SetMetadata, UseGuards } from "@nestjs/common";
import { EntitlementGuard } from "./entitlement.guard";

export const REQUIRED_ENTITLEMENT = "requiredEntitlement";

/** A fixed key, or a function of the request (null = no entitlement needed for this request). */
export type EntitlementRequirement =
  | string
  | ((req: {
      query?: Record<string, unknown>;
      params?: Record<string, unknown>;
    }) => string | null);

/**
 * Marks a route (or every route of a controller) as needing a plan
 * entitlement. Enforced by EntitlementGuard only while subscriptions are live
 * (SUBSCRIPTIONS_ENABLED on + a provider configured); otherwise a no-op.
 * Free users get 403 { code: "plan_required", requiredPlan }.
 */
export const RequiresEntitlement = (requirement: EntitlementRequirement) =>
  applyDecorators(
    SetMetadata(REQUIRED_ENTITLEMENT, requirement),
    UseGuards(EntitlementGuard),
  );
