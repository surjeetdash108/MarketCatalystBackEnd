import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { PlansModule } from "../plans/plans.module";
import { EntitlementGuard } from "./entitlement.guard";

/**
 * The plan gate runs on every route as a global guard; its route → feature
 * map is plans.registry.ts (ROUTE_FEATURES / PLAN_EXEMPT_ROUTES).
 */
@Global()
@Module({
  imports: [PlansModule],
  providers: [EntitlementGuard, { provide: APP_GUARD, useExisting: EntitlementGuard }],
  exports: [EntitlementGuard, PlansModule],
})
export class EntitlementsModule {}
