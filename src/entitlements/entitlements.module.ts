import { Global, Module } from "@nestjs/common";
import { PlansModule } from "../plans/plans.module";
import { EntitlementGuard } from "./entitlement.guard";

/** Global so @RequiresEntitlement works in every module's controllers. */
@Global()
@Module({
  imports: [PlansModule],
  providers: [EntitlementGuard],
  exports: [EntitlementGuard, PlansModule],
})
export class EntitlementsModule {}
