// blogs-admin imports the ESM-only `marked`; this spec reads route metadata only.
jest.mock("marked", () => ({ marked: { parse: (s: string) => s } }));

import { StaffAccessService } from "../account/staff-access.service";
import type { AuthTokenInfo } from "../common/auth-token";
import {
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  INestApplication,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { billingHarness, configOf } from "../../test/support/billing-harness";
import { BillingAccessService } from "../billing/billing-access.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import {
  ENTITLEMENTS,
  PLAN_DEFINITIONS,
  PLAN_GROUPS,
  ROUTE_FEATURES,
  groupOf,
  isPlanExempt,
} from "../plans/plans.registry";
import { SubscriptionsService } from "../plans/subscriptions.service";
import { EntitlementGuard } from "./entitlement.guard";
import { routeInventory, type RouteInfo } from "./route-inventory";

// Many guard calls per test; the 5 s default flakes under parallel load.
jest.setTimeout(60_000);

/**
 * Access matrix: EVERY controller route × no plan / Starter / Pro / Elite /
 * staff, through the real EntitlementGuard and resolver, with the
 * expectation derived from the registry's feature groups (not restated here).
 */
const ROUTES = routeInventory();
const key = (r: RouteInfo) => `${r.method} ${r.path}`;
const exempt = (r: RouteInfo) =>
  r.isPublic || r.guards.includes("AdminGuard") || isPlanExempt(r.path);
const PLANS = ["none", "starter", "pro", "elite"] as const;
const RANK: Record<string, number> = { none: 0, starter: 1, pro: 2, elite: 3 };

/** Lowest plan that grants ANY of the route's features, from PLAN_GROUPS. */
function minPlanFor(features: string[]): string {
  const ladder = PLAN_DEFINITIONS.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  for (const p of ladder)
    if (features.some((f) => PLAN_GROUPS[p.id].includes(groupOf(f)!))) return p.id;
  throw new Error(`no plan grants ${features.join(",")}`);
}

const TOKENS: Record<string, AuthTokenInfo> = {};
const tokenFor = (uid: string, email: string, emailVerified: boolean) => {
  TOKENS[uid] = { uid, email, emailVerified, claims: {}, signInProvider: emailVerified ? "google.com" : "password" };
};

function ctxFor(r: RouteInfo, uid: string, query: Record<string, unknown> = {}): ExecutionContext {
  const req = { uid, query, params: {}, headers: {}, authToken: TOKENS[uid] };
  return {
    getType: () => "http",
    getHandler: () => r.handler,
    getClass: () => r.cls,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

async function guardWith(env: Record<string, string>, providerOn = true) {
  const h = billingHarness(env);
  const flags = new FeatureFlagsService(h.firebase, configOf(env));
  const access = new BillingAccessService(flags, providerOn ? h.provider : null);
  const auth = { canActivate: () => Promise.reject(new Error("uid already set")) } as unknown as FirebaseAuthGuard;
  const fresh = () => new EntitlementGuard(access, h.subscriptions, auth, new StaffAccessService(h.firebase));
  await h.buy("starter-user", "starter", "monthly");
  await h.buy("pro-user", "pro", "monthly");
  await h.buy("elite-user", "elite", "annual");
  return { h, guard: fresh(), fresh };
}

async function verdict(guard: EntitlementGuard, r: RouteInfo, uid: string, query?: Record<string, unknown>): Promise<number> {
  try {
    await guard.canActivate(ctxFor(r, uid, query));
    return 200;
  } catch (e) {
    if (e instanceof ForbiddenException) return 403;
    throw e;
  }
}
const uidFor = (p: string) => (p === "none" ? "nobody" : `${p}-user`);

describe("route ↔ feature-group contract (plans.registry.ts is the only list)", () => {
  it("every controller route is either exempt or mapped to a feature", () => {
    const unmapped = ROUTES.filter((r) => !exempt(r) && !ROUTE_FEATURES[key(r)]).map(key);
    expect(unmapped).toEqual([]);
    expect(ROUTES.length).toBeGreaterThan(150);
  });
  it("no stale entries: every mapped route exists", () => {
    const real = new Set(ROUTES.map(key));
    expect(Object.keys(ROUTE_FEATURES).filter((k) => !real.has(k))).toEqual([]);
  });
  it("every mapped feature belongs to a feature group and is sold", () => {
    for (const [k, req] of Object.entries(ROUTE_FEATURES)) {
      const features = req === "bars" ? ["chartsDaily", "chartsIntraday", "chartsHistory"] : req;
      for (const f of features) {
        const e = ENTITLEMENTS.find((x) => x.key === f);
        expect([k, f, !!e?.featureGroup, !!e?.unbuilt, !!e?.staffOnly]).toEqual([k, f, true, false, false]);
      }
    }
  });
  it("the previously unguarded features are enforced on a backend route", () => {
    const used = new Set(Object.values(ROUTE_FEATURES).flatMap((r) => (r === "bars" ? [] : r)));
    for (const f of ["screener", "recaps", "technicalRatings", "chartIndicators", "institutionalMovers", "backtesting"])
      expect([f, used.has(f)]).toEqual([f, true]);
  });
});

describe("access matrix (SUBSCRIPTIONS_ENABLED on, provider configured)", () => {
  let g: Awaited<ReturnType<typeof guardWith>>;
  beforeAll(async () => {
    g = await guardWith({ SUBSCRIPTIONS_ENABLED: "true" });
  });

  it("every mapped route: allowed exactly from its feature group's lowest plan; no plan → 403", async () => {
    for (const r of ROUTES.filter((x) => !exempt(x) && ROUTE_FEATURES[key(x)])) {
      const req = ROUTE_FEATURES[key(r)];
      const need = minPlanFor(req === "bars" ? ["chartsDaily"] : req);
      const got: Record<string, number> = {};
      for (const p of PLANS) got[p] = await verdict(g.guard, r, uidFor(p), { tf: "1Y" });
      const want = Object.fromEntries(PLANS.map((p) => [p, RANK[p] >= RANK[need] ? 200 : 403]));
      expect([key(r), got]).toEqual([key(r), want]);
    }
  });

  it("exempt routes (sign-in, account, Manage Plan, checkout, billing history, catalog) stay open without a plan", async () => {
    const open = ROUTES.filter((r) => isPlanExempt(r.path));
    expect(open.map(key)).toEqual(expect.arrayContaining(["GET /api/billing/summary", "POST /api/billing/checkout", "GET /api/billing/history", "GET /api/me/entitlements", "GET /api/profile", "GET /plans"]));
    for (const r of open) expect([key(r), await verdict(g.guard, r, "nobody")]).toEqual([key(r), 200]);
  });

  it("Market Desk and Stock Intelligence on Starter; Money Flow from Pro; Strategy Lab only on Elite", async () => {
    const at = (k: string) => ROUTES.find((r) => key(r) === k)!;
    const row = async (k: string) => Promise.all(PLANS.map((p) => verdict(g.guard, at(k), uidFor(p))));
    expect(await row("GET /market-data/recaps")).toEqual([403, 200, 200, 200]);
    expect(await row("GET /market-data/companies")).toEqual([403, 200, 200, 200]);
    expect(await row("GET /live/financials")).toEqual([403, 200, 200, 200]);
    expect(await row("GET /live/money-flow")).toEqual([403, 403, 200, 200]);
    expect(await row("GET /live/options-chain")).toEqual([403, 403, 200, 200]);
    expect(await row("GET /live/strategy-lab/bars")).toEqual([403, 403, 403, 200]);
  });

  it("/live/bars: every range needs Stock Intelligence (no plan → 403)", async () => {
    const bars = ROUTES.find((r) => key(r) === "GET /live/bars")!;
    for (const q of [{ tf: "1Y" }, { tf: "1D" }, { interval: "5min" }, { tf: "5Y" }]) {
      expect(await verdict(g.guard, bars, "nobody", q)).toBe(403);
      expect(await verdict(g.guard, bars, "starter-user", q)).toBe(200);
    }
  });

  it("past due keeps access for the 7-day grace, then no plan", async () => {
    const h = g.h;
    await h.buy("late-payer", "pro", "monthly", "renewal_failure");
    const mf = ROUTES.find((r) => key(r) === "GET /live/money-flow")!;
    await h.provider.advanceDays(31);
    expect(await verdict(g.fresh(), mf, "late-payer")).toBe(200);
    await h.provider.advanceDays(8);
    expect(await verdict(g.fresh(), mf, "late-payer")).toBe(403);
    expect((await h.subscriptions.forUser("late-payer")).planId).toBe("none");
  });
});

describe("staff full access", () => {
  const seedStaff = (h: { firebase: { firestore: { doc: (p: string) => { set: (d: object) => Promise<unknown> } } } }, emails: string[]) =>
    h.firebase.firestore.doc("config/staff_access").set({ emails });

  it.each([["true"], ["false"]])("a verified staff email passes every route (SUBSCRIPTIONS_ENABLED=%s)", async (flag) => {
    const g = await guardWith({ SUBSCRIPTIONS_ENABLED: flag });
    await seedStaff(g.h, ["ops-staff@example.com"]);
    tokenFor("staffer", "Ops-Staff@Example.com", true);
    const guard = g.fresh();
    for (const r of ROUTES) expect([key(r), await verdict(guard, r, "staffer", { tf: "1D", interval: "5min" })]).toEqual([key(r), 200]);
  });

  it("an UNVERIFIED account using a staff email gets nothing (no plan)", async () => {
    const g = await guardWith({ SUBSCRIPTIONS_ENABLED: "true" });
    await seedStaff(g.h, ["ops-staff@example.com"]);
    tokenFor("impostor", "ops-staff@example.com", false);
    const mf = ROUTES.find((r) => key(r) === "GET /market-data/news")!;
    expect(await verdict(g.fresh(), mf, "impostor")).toBe(403);
  });

  it("removed from the list → access drops", async () => {
    const g = await guardWith({ SUBSCRIPTIONS_ENABLED: "true" });
    await seedStaff(g.h, ["ops-staff@example.com"]);
    tokenFor("leaver", "ops-staff@example.com", true);
    const mf = ROUTES.find((r) => key(r) === "GET /live/money-flow")!;
    expect(await verdict(g.fresh(), mf, "leaver")).toBe(200);
    await seedStaff(g.h, []);
    expect(await verdict(g.fresh(), mf, "leaver")).toBe(403);
  });
});

describe("enforcement switches (flag off = today's behaviour)", () => {
  it("flag OFF: every route open to an account with no plan", async () => {
    const { guard } = await guardWith({ SUBSCRIPTIONS_ENABLED: "false" });
    for (const r of ROUTES) expect([key(r), await verdict(guard, r, "nobody")]).toEqual([key(r), 200]);
  });
  it("no provider configured: nothing gated even with the flag on", async () => {
    const { guard } = await guardWith({ SUBSCRIPTIONS_ENABLED: "true" }, false);
    for (const r of ROUTES) expect([key(r), await verdict(guard, r, "nobody")]).toEqual([key(r), 200]);
  });
});

@Controller("live")
class ProbeMoneyFlow {
  @Get("money-flow")
  mf() {
    return { ok: true };
  }
}
@Controller("probe")
class ProbeUnmapped {
  @Get("unmapped")
  u() {
    return { ok: true };
  }
}

describe("403 body (global guard over a Nest app)", () => {
  let app: INestApplication;
  afterAll(() => app?.close());
  it("is { code: plan_required, requiredPlan, entitlement, message }; unmapped routes default to Market Desk", async () => {
    const { h } = await guardWith({ SUBSCRIPTIONS_ENABLED: "true" });
    const flags = new FeatureFlagsService(h.firebase, configOf({ SUBSCRIPTIONS_ENABLED: "true" }));
    const mod = await Test.createTestingModule({
      controllers: [ProbeMoneyFlow, ProbeUnmapped],
      providers: [
        EntitlementGuard,
        { provide: APP_GUARD, useExisting: EntitlementGuard },
        { provide: BillingAccessService, useValue: new BillingAccessService(flags, h.provider) },
        { provide: SubscriptionsService, useValue: h.subscriptions },
        { provide: StaffAccessService, useValue: new StaffAccessService(h.firebase) },
        {
          provide: FirebaseAuthGuard,
          useValue: {
            canActivate: (c: ExecutionContext) => {
              const req = c.switchToHttp().getRequest<{ headers: Record<string, string>; uid?: string }>();
              req.uid = req.headers["x-test-uid"];
              return true;
            },
          },
        },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    const s = app.getHttpServer();
    const r = await request(s).get("/live/money-flow").set("x-test-uid", "starter-user");
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ statusCode: 403, code: "plan_required", entitlement: "moneyFlow", requiredPlan: "pro", message: "Available on Pro." });
    expect((await request(s).get("/live/money-flow").set("x-test-uid", "pro-user")).status).toBe(200);
    const u = await request(s).get("/probe/unmapped").set("x-test-uid", "nobody");
    expect(u.body).toMatchObject({ code: "plan_required", requiredPlan: "starter" });
  });
});
