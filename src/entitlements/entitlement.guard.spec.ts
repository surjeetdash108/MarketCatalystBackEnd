// blogs-admin imports the ESM-only `marked`; this spec reads route metadata only.
jest.mock("marked", () => ({ marked: { parse: (s: string) => s } }));

import { readdirSync, statSync } from "fs";
import { join } from "path";
import {
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  INestApplication,
  Query,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import request from "supertest";
import { billingHarness, configOf } from "../../test/support/billing-harness";
import { BillingAccessService } from "../billing/billing-access.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { SubscriptionsService } from "../plans/subscriptions.service";
import { EntitlementGuard } from "./entitlement.guard";
import {
  REQUIRED_ENTITLEMENT,
  RequiresEntitlement,
  type EntitlementRequirement,
} from "./requires-entitlement.decorator";

// Many HTTP round-trips per test; the 5 s default flakes under parallel load.
jest.setTimeout(30_000);

/**
 * Route access matrix: every route carrying @RequiresEntitlement, called as a
 * Free, Starter, Pro and Elite user, through the real EntitlementGuard and
 * resolver. Expected plan per route group = the doc's route map.
 */

const SRC = join(__dirname, "..");
function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory()
      ? controllerFiles(p)
      : p.endsWith(".controller.ts")
        ? [p]
        : [];
  });
}

interface GatedRoute {
  key: string;
  handler: (...a: unknown[]) => unknown;
  cls: new (...a: unknown[]) => unknown;
  requirement: EntitlementRequirement;
}

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
function gatedRoutes(): GatedRoute[] {
  const out: GatedRoute[] = [];
  for (const file of controllerFiles(SRC)) {
    for (const C of Object.values(require(file) as Record<string, unknown>)) {
      if (
        typeof C !== "function" ||
        Reflect.getMetadata(PATH_METADATA, C) === undefined
      )
        continue;
      const base = String(
        [Reflect.getMetadata(PATH_METADATA, C)].flat()[0] ?? "",
      );
      const proto = (C as { prototype: object }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = Object.getOwnPropertyDescriptor(proto, name)?.value;
        if (typeof handler !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) continue;
        const requirement =
          Reflect.getMetadata(REQUIRED_ENTITLEMENT, handler) ??
          Reflect.getMetadata(REQUIRED_ENTITLEMENT, C);
        if (!requirement) continue;
        const guards = [
          ...(Reflect.getMetadata(GUARDS_METADATA, C) ?? []),
          ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? []),
        ].map((g: { name: string }) => g.name);
        expect(guards).toContain("EntitlementGuard");
        const path = String(
          [Reflect.getMetadata(PATH_METADATA, handler)].flat()[0] ?? "",
        );
        out.push({
          key: `${["GET", "POST", "PUT", "DELETE", "PATCH"][method as number] ?? method} /${[base, path].filter(Boolean).join("/").replace(/\/+/g, "/")}`,
          handler,
          cls: C as never,
          requirement,
        });
      }
    }
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */

/** The doc's route map: lowest plan each gated route group needs. */
const ROUTE_MAP: Array<[RegExp, "starter" | "pro" | "elite"]> = [
  [
    /^GET \/market-data\/(institutional-ownership|fund-holdings|insider-transactions)/,
    "starter",
  ],
  [
    /^GET \/market-data\/(analyst-|filings-wire|recaps|ai-infrastructure|etf-holdings|mover-catalyst|earnings-announcements)/,
    "starter",
  ],
  [
    /^(GET|POST) \/live\/(ticker-analysis|ticker-announcements|glance\/|ai-analysis|copilot|estimates|peers-summary|dividend-history|ownership|financials|13f-filings|filing|earnings-transcript|etf-market|etfs\/market-funds)/,
    "starter",
  ],
  [/^(GET|POST|DELETE) \/api\/(portfolio|stock-notes|ai\/)/, "starter"],
  [/^GET \/live\/(money-flow|options-chain)/, "pro"],
  [/\/live\/strategy-lab\//, "elite"],
];
const RANK = { free: 0, starter: 1, pro: 2, elite: 3 } as const;

function ctxFor(
  route: GatedRoute,
  uid: string,
  query: Record<string, unknown> = {},
): ExecutionContext {
  const req = { uid, query, params: {}, headers: {} };
  return {
    getHandler: () => route.handler,
    getClass: () => route.cls,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

async function guardWith(env: Record<string, string>, providerOn = true) {
  const h = billingHarness(env);
  const flags = new FeatureFlagsService(h.firebase, configOf(env));
  const access = new BillingAccessService(
    flags,
    providerOn ? h.provider : null,
  );
  const auth = {
    canActivate: () =>
      Promise.reject(new Error("should not be needed: uid already set")),
  } as unknown as FirebaseAuthGuard;
  const guard = new EntitlementGuard(
    new Reflector(),
    access,
    h.subscriptions,
    auth,
  );
  await h.buy("starter-user", "starter", "monthly");
  await h.buy("pro-user", "pro", "monthly");
  await h.buy("elite-user", "elite", "annual");
  const fresh = () =>
    new EntitlementGuard(new Reflector(), access, h.subscriptions, auth);
  return { h, guard, fresh };
}

async function verdict(
  guard: EntitlementGuard,
  route: GatedRoute,
  uid: string,
  query?: Record<string, unknown>,
): Promise<number> {
  try {
    await guard.canActivate(ctxFor(route, uid, query));
    return 200;
  } catch (e) {
    if (e instanceof ForbiddenException) return 403;
    throw e;
  }
}

describe("route access matrix (SUBSCRIPTIONS_ENABLED on, provider configured)", () => {
  const routes = gatedRoutes();
  let g: Awaited<ReturnType<typeof guardWith>>;
  beforeAll(async () => {
    g = await guardWith({ SUBSCRIPTIONS_ENABLED: "true" });
  });

  it("finds every gated route group from the doc's route map", () => {
    const fixed = routes.filter((r) => typeof r.requirement === "string");
    expect(fixed.length).toBeGreaterThanOrEqual(40);
    for (const r of fixed)
      expect([r.key, ROUTE_MAP.some(([re]) => re.test(r.key))]).toEqual([
        r.key,
        true,
      ]);
  });

  it("every fixed-requirement route: Free 403; Starter/Pro/Elite allowed exactly from their plan", async () => {
    const rows: string[] = [];
    for (const r of routes.filter((x) => typeof x.requirement === "string")) {
      const need = ROUTE_MAP.find(([re]) => re.test(r.key))[1];
      const got = {
        free: await verdict(g.guard, r, "nobody"),
        starter: await verdict(g.guard, r, "starter-user"),
        pro: await verdict(g.guard, r, "pro-user"),
        elite: await verdict(g.guard, r, "elite-user"),
      };
      const want = Object.fromEntries(
        (["free", "starter", "pro", "elite"] as const).map((p) => [
          p,
          RANK[p] >= RANK[need] ? 200 : 403,
        ]),
      );
      rows.push(
        `${r.key.padEnd(52)} need=${need.padEnd(7)} free=${got.free} starter=${got.starter} pro=${got.pro} elite=${got.elite}`,
      );
      expect([r.key, got]).toEqual([r.key, want]);
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  it("/live/bars: daily ranges Free; intraday needs Starter; 5Y needs Starter", async () => {
    const bars = routes.find((r) => r.key === "GET /live/bars");
    expect(await verdict(g.guard, bars, "nobody", { tf: "1Y" })).toBe(200);
    expect(await verdict(g.guard, bars, "nobody", { tf: "1D" })).toBe(403);
    expect(await verdict(g.guard, bars, "nobody", { interval: "5min" })).toBe(
      403,
    );
    expect(await verdict(g.guard, bars, "nobody", { tf: "5Y" })).toBe(403);
    expect(await verdict(g.guard, bars, "starter-user", { tf: "1D" })).toBe(
      200,
    );
  });

  it("a past-due user keeps access during the 7-day grace, then loses it", async () => {
    const h = g.h;
    await h.buy("late-payer", "pro", "monthly", "renewal_failure");
    const moneyFlow = routes.find((r) => r.key === "GET /live/money-flow");
    await h.provider.advanceDays(31);
    expect(await verdict(g.fresh(), moneyFlow, "late-payer")).toBe(200);
    await h.provider.advanceDays(8);
    expect(await verdict(g.fresh(), moneyFlow, "late-payer")).toBe(403);
    expect((await h.subscriptions.forUser("late-payer")).planId).toBe("free");
  });
});

describe("enforcement switches", () => {
  const route = gatedRoutes().find(
    (r) => r.key === "GET /live/strategy-lab/universe",
  );

  it("flag OFF: no route is gated (today's behaviour)", async () => {
    const { guard } = await guardWith({ SUBSCRIPTIONS_ENABLED: "false" });
    expect(await verdict(guard, route, "nobody")).toBe(200);
  });

  it("no provider configured: no route is gated even with the flag on", async () => {
    const { guard } = await guardWith({ SUBSCRIPTIONS_ENABLED: "true" }, false);
    expect(await verdict(guard, route, "nobody")).toBe(200);
  });
});

@Controller("probe")
class ProbeController {
  @RequiresEntitlement("moneyFlow")
  @Get("pro-only")
  proOnly(@Query("x") _x?: string) {
    return { ok: true };
  }
}

describe("403 response body", () => {
  let app: INestApplication;
  afterAll(() => app?.close());

  it("is { code: plan_required, requiredPlan, entitlement, message }", async () => {
    const { h } = await guardWith({ SUBSCRIPTIONS_ENABLED: "true" });
    const flags = new FeatureFlagsService(
      h.firebase,
      configOf({ SUBSCRIPTIONS_ENABLED: "true" }),
    );
    const mod = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        EntitlementGuard,
        {
          provide: BillingAccessService,
          useValue: new BillingAccessService(flags, h.provider),
        },
        { provide: SubscriptionsService, useValue: h.subscriptions },
        {
          provide: FirebaseAuthGuard,
          useValue: {
            canActivate: (c: ExecutionContext) => {
              const req = c.switchToHttp().getRequest<{
                headers: Record<string, string>;
                uid?: string;
              }>();
              req.uid = req.headers["x-test-uid"];
              return true;
            },
          },
        },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    const r = await request(app.getHttpServer())
      .get("/probe/pro-only")
      .set("x-test-uid", "starter-user");
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      statusCode: 403,
      code: "plan_required",
      entitlement: "moneyFlow",
      requiredPlan: "pro",
      message: "Available on Pro.",
    });
    expect(
      (
        await request(app.getHttpServer())
          .get("/probe/pro-only")
          .set("x-test-uid", "pro-user")
      ).status,
    ).toBe(200);
  });
});
