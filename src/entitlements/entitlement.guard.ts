import { StaffAccessService } from "../account/staff-access.service";
import type { AuthTokenInfo } from "../common/auth-token";
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { BillingAccessService } from "../billing/billing-access.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { lowestPlanFor } from "../plans/plans.registry";
import {
  SubscriptionsService,
  type EffectiveSubscription,
} from "../plans/subscriptions.service";
import type { EntitlementRequirement } from "./requires-entitlement.decorator";

const REQUIRED_ENTITLEMENT = "requiredEntitlement";
/** Short per-instance cache; plan changes are visible within this window. */
export const ENTITLEMENT_CACHE_MS = 5_000;

@Injectable()
export class EntitlementGuard implements CanActivate {
  private readonly cache = new Map<
    string,
    { at: number; value: EffectiveSubscription }
  >();

  constructor(
    private readonly reflector: Reflector,
    private readonly access: BillingAccessService,
    private readonly subscriptions: SubscriptionsService,
    private readonly auth: FirebaseAuthGuard,
    private readonly staff: StaffAccessService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<
      EntitlementRequirement | undefined
    >(REQUIRED_ENTITLEMENT, [ctx.getHandler(), ctx.getClass()]);
    if (!requirement) return true;
    const req = ctx.switchToHttp().getRequest<{
      uid?: string;
      authToken?: AuthTokenInfo;
      query?: Record<string, unknown>;
      params?: Record<string, unknown>;
    }>();
    const key =
      typeof requirement === "function" ? requirement(req) : requirement;
    if (!key) return true;
    if (!(await this.access.subscriptionsLive())) return true; // flag off or no provider: today's behaviour
    if (!req.uid) await this.auth.canActivate(ctx); // guard order independent: authenticate first
    if (await this.staff.isStaff(req.authToken)) return true; // staff: every route group
    const effective = await this.effective(req.uid);
    if (effective.entitlements[key] === true) return true;
    const plan = lowestPlanFor(key);
    throw new ForbiddenException({
      statusCode: 403,
      code: "plan_required",
      entitlement: key,
      requiredPlan: plan?.id ?? null,
      message: plan
        ? `Available on ${plan.name}.`
        : "Not available on your plan.",
    });
  }

  private async effective(uid: string): Promise<EffectiveSubscription> {
    const hit = this.cache.get(uid);
    if (hit && Date.now() - hit.at < ENTITLEMENT_CACHE_MS) return hit.value;
    const value = await this.subscriptions.forUser(uid);
    this.cache.set(uid, { at: Date.now(), value });
    if (this.cache.size > 5000) this.cache.clear();
    return value;
  }
}
