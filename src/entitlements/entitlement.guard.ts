import { StaffAccessService } from "../account/staff-access.service";
import { isLifetimeElite } from "../plans/lifetime-elite";
import type { AuthTokenInfo } from "../common/auth-token";
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { BillingAccessService } from "../billing/billing-access.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { PUBLIC_ROUTE } from "../common/public.decorator";
import {
  isPlanExempt,
  lowestPlanFor,
  routeRequirement,
} from "../plans/plans.registry";
import {
  SubscriptionsService,
  type EffectiveSubscription,
} from "../plans/subscriptions.service";

/** Short per-instance cache; plan changes are visible within this window. */
export const ENTITLEMENT_CACHE_MS = 5_000;

/** Unmapped signed-in routes default to Market Desk (route-groups.spec.ts keeps this list empty). */
const DEFAULT_REQUIREMENT = ["marketCatalyst"];

export function joinRoute(prefix: unknown, sub: unknown): string {
  const parts = [prefix, sub]
    .map((x) => String(Array.isArray(x) ? x[0] : (x ?? "")))
    .map((x) => x.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return ("/" + parts.join("/")).replace(/\/+/g, "/");
}

/**
 * The plan gate for EVERY route (registered as a global guard).
 *
 * The requirement comes from the registry (plans.registry.ts ROUTE_FEATURES,
 * PLAN_EXEMPT_ROUTES) — there is no per-controller decorator to keep in step.
 * Exempt: @Public routes, admin-guarded routes and PLAN_EXEMPT_ROUTES (sign-in,
 * account, Manage Plan, checkout, billing history, catalog). Everything else
 * needs one of the route's features. A no-plan account has none, so it gets
 * 403 { code: "plan_required", requiredPlan: "starter" } everywhere else.
 *
 * Only while subscriptions are live (SUBSCRIPTIONS_ENABLED on + a provider);
 * otherwise a no-op — everyone keeps today's access. Staff: everything.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  private readonly cache = new Map<
    string,
    { at: number; value: EffectiveSubscription }
  >();

  constructor(
    private readonly access: BillingAccessService,
    private readonly subscriptions: SubscriptionsService,
    private readonly auth: FirebaseAuthGuard,
    private readonly staff: StaffAccessService,
  ) {}

  /** "METHOD /path" for the matched handler, from Nest's route metadata. */
  static routeKeyOf(ctx: ExecutionContext): {
    key: string;
    path: string;
    exemptByMetadata: boolean;
  } {
    const cls = ctx.getClass();
    const handler = ctx.getHandler();
    const m = Reflect.getMetadata(METHOD_METADATA, handler) as
      RequestMethod | undefined;
    const path = joinRoute(
      Reflect.getMetadata(PATH_METADATA, cls),
      Reflect.getMetadata(PATH_METADATA, handler),
    );
    const guards = [
      ...((Reflect.getMetadata(GUARDS_METADATA, cls) ?? []) as Array<{ name?: string }>),
      ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as Array<{ name?: string }>),
    ].map((g) => g?.name);
    const isPublic =
      typeof Reflect.getMetadata(PUBLIC_ROUTE, handler) === "string" ||
      typeof Reflect.getMetadata(PUBLIC_ROUTE, cls) === "string";
    return {
      key: `${m === undefined ? "GET" : RequestMethod[m]} ${path}`,
      path,
      exemptByMetadata: isPublic || guards.includes("AdminGuard"),
    };
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== "http") return true;
    const route = EntitlementGuard.routeKeyOf(ctx);
    if (route.exemptByMetadata || isPlanExempt(route.path)) return true;
    const req = ctx.switchToHttp().getRequest<{
      uid?: string;
      authToken?: AuthTokenInfo;
      query?: Record<string, unknown>;
    }>();
    const keys =
      routeRequirement(route.key, req.query ?? {}) ?? DEFAULT_REQUIREMENT;
    if (!(await this.access.subscriptionsLive())) return true; // flag off or no provider: today's behaviour
    if (!req.uid) await this.auth.canActivate(ctx); // authenticate first (global guards run before controller guards)
    if (await this.staff.isStaff(req.authToken)) return true; // staff: every route
    if (isLifetimeElite(req.authToken?.email)) return true; // lifetime elite: every route
    const effective = await this.effective(req.uid!);
    if (keys.some((k) => effective.entitlements[k] === true)) return true;
    const plan = lowestPlanFor(keys[0]);
    throw new ForbiddenException({
      statusCode: 403,
      code: "plan_required",
      entitlement: keys[0],
      requiredPlan: plan?.id ?? null,
      message: plan ? `Available on ${plan.name}.` : "Choose a plan to continue.",
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
