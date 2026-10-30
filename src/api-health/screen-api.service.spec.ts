import {
  ScreenApiService,
  authLevel,
  rollupApiStatus,
  rollupScreenStatus,
  summariseProbe,
  type ProbeSummary,
  type ProducerState,
} from "./screen-api.service";
import { API_CATALOG, SCREENS } from "./screen-api.registry";

const NOW = new Date("2026-10-30T14:07:00.000Z"); // Fri 10:07 EDT, market hours

const producer = (job: string, health: ProducerState["health"], over: Partial<ProducerState> = {}): ProducerState => ({
  job,
  health,
  lastSyncedAt: "2026-10-30T14:00:00Z",
  lastStatus: health === "failing" ? "error" : "ok",
  lastError: health === "failing" ? "FMP 503" : null,
  nextRunAt: null,
  expectedBy: null,
  ...over,
});

const OK_PROBE: ProbeSummary = { state: "ok", status: 200, ms: 41 };
const NOT_PROBED: ProbeSummary = { state: "not-probed", reason: "requires auth" };

describe("authLevel", () => {
  it("reads access from the guards on the route", () => {
    expect(authLevel(["FirebaseAuthGuard"])).toBe("login");
    expect(authLevel(["DelistedTickerGuard", "FirebaseAuthGuard"])).toBe("login");
    expect(authLevel(["AdminGuard"])).toBe("admin");
    expect(authLevel(["McpApiKeyGuard"])).toBe("mcp-key");
    expect(authLevel([])).toBe("public");
  });
  it("does not mistake the delisted-ticker check for a login", () => {
    expect(authLevel(["DelistedTickerGuard"])).toBe("public");
  });
  it("lets the strongest guard win", () => {
    expect(authLevel(["FirebaseAuthGuard", "AdminGuard"])).toBe("admin");
  });
});

describe("summariseProbe", () => {
  it("separates success, reachable-but-rejected, down and not-probed", () => {
    expect(summariseProbe({ status: 200, ok: true, up: true, ms: 12 })).toEqual({ state: "ok", status: 200, ms: 12 });
    expect(summariseProbe({ status: 400, ok: false, up: true, ms: 9 })).toEqual({ state: "reachable", status: 400, ms: 9 });
    expect(summariseProbe({ status: 503, ok: false, up: false, ms: 80 })).toMatchObject({ state: "down", status: 503 });
    expect(summariseProbe({ skipped: true, reason: "requires auth" })).toEqual({ state: "not-probed", reason: "requires auth" });
    expect(summariseProbe(undefined).state).toBe("not-probed");
  });
});

describe("rollupApiStatus", () => {
  const base = { registered: true, workerOnly: false, probe: NOT_PROBED, producers: [] as ProducerState[] };

  it("calls a documented route the service does not have missing — the doc or the deploy is wrong", () => {
    const r = rollupApiStatus({ ...base, registered: false });
    expect(r.status).toBe("missing");
    expect(r.reasons[0]).toMatch(/out of date|lacks the route/);
  });

  it("does not call a worker-only route missing from the live service", () => {
    expect(rollupApiStatus({ ...base, registered: false, workerOnly: true }).status).toBe("unknown");
  });

  it("is down when the probe could not reach it, whatever its producers say", () => {
    const r = rollupApiStatus({ ...base, probe: { state: "down", status: 503, ms: 90 }, producers: [producer("sectors", "ok")] });
    expect(r.status).toBe("down");
    expect(r.reasons.join(" ")).toMatch(/probe failed/i);
  });

  it("is ok when the probe got through and nothing feeding it is wrong", () => {
    expect(rollupApiStatus({ ...base, probe: OK_PROBE, producers: [producer("sectors", "ok")] }).status).toBe("ok");
  });

  it("treats reachable-but-4xx as fine: the unattended probe sends no parameters", () => {
    const r = rollupApiStatus({ ...base, probe: { state: "reachable", status: 400, ms: 8 } });
    expect(r.status).toBe("ok");
    expect(r.reasons.join(" ")).toMatch(/sends no parameters/);
  });

  it("is degraded when a job that fills its data failed last time — even if the route answers", () => {
    const r = rollupApiStatus({ ...base, probe: OK_PROBE, producers: [producer("market-movers", "failing")] });
    expect(r.status).toBe("degraded");
    expect(r.reasons.join(" ")).toContain("market-movers failed on its last run: FMP 503");
  });

  it("is degraded when a producer has gone quiet, and says when it was due", () => {
    const r = rollupApiStatus({ ...base, producers: [producer("news", "late", { expectedBy: "2026-10-30T11:00:00.000Z" })] });
    expect(r.status).toBe("degraded");
    expect(r.reasons.join(" ")).toContain("2026-10-30T11:00:00.000Z");
  });

  it("is degraded when a producer has never run, since the data may not exist", () => {
    expect(rollupApiStatus({ ...base, producers: [producer("ipos", "never-run")] }).status).toBe("degraded");
  });

  it("keeps down over degraded and lists both reasons", () => {
    const r = rollupApiStatus({ ...base, probe: { state: "down", status: 0, ms: 5, error: "ECONNREFUSED" }, producers: [producer("news", "failing")] });
    expect(r.status).toBe("down");
    expect(r.reasons.join(" ")).toMatch(/ECONNREFUSED/);
    expect(r.reasons.join(" ")).toMatch(/news failed/);
  });

  it("counts a healthy producer as evidence even when the route is not probed", () => {
    const r = rollupApiStatus({ ...base, producers: [producer("sectors", "ok"), producer("x", "manual")] });
    expect(r.status).toBe("ok");
    expect(r.reasons[0]).toMatch(/Not probed/);
  });

  it("says unknown — not ok — when nothing at all is known", () => {
    const r = rollupApiStatus(base);
    expect(r.status).toBe("unknown");
    expect(r.reasons.join(" ")).toMatch(/Not monitored/);
  });

  it("does not judge freshness when run history was unreadable — no phantom outage", () => {
    const unreadable = [producer("sectors", "unknown"), producer("news", "unknown")];
    const r = rollupApiStatus({ ...base, producers: unreadable });
    expect(r.status).toBe("unknown"); // not degraded, and not vouched for either
    expect(r.reasons.join(" ")).toMatch(/could not be read/);
    // …but a probe that did get through still counts.
    expect(rollupApiStatus({ ...base, probe: OK_PROBE, producers: unreadable }).status).toBe("ok");
  });

  it("does not let an unavailable probe change the verdict", () => {
    const r = rollupApiStatus({ ...base, probe: { state: "unavailable", reason: "boom" }, producers: [producer("ipos", "ok")] });
    expect(r.status).toBe("ok");
    expect(r.reasons.join(" ")).toMatch(/probe unavailable/i);
  });
});

describe("rollupScreenStatus", () => {
  it("is as bad as its worst API, in the order down > missing > degraded", () => {
    expect(rollupScreenStatus(["ok", "degraded", "down"])).toBe("down");
    expect(rollupScreenStatus(["ok", "missing", "degraded"])).toBe("missing");
    expect(rollupScreenStatus(["ok", "degraded", "unknown"])).toBe("degraded");
  });
  it("lets unknown APIs sit beside healthy ones without hiding them", () => {
    expect(rollupScreenStatus(["unknown", "ok", "unknown"])).toBe("ok");
    expect(rollupScreenStatus(["unknown", "unknown"])).toBe("unknown");
  });
  it("calls a screen with no backend calls unknown", () => {
    expect(rollupScreenStatus([])).toBe("unknown");
  });
});

describe("ScreenApiService.report", () => {
  type Route = { method: string; path: string; controller: string; guarded: boolean; guards: string[] };
  const route = (key: string, guards: string[] = ["FirebaseAuthGuard"]): Route => {
    const [method, path] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
    return { method, path, controller: "FakeController", guarded: guards.length > 0, guards };
  };

  /** Registers every catalogued route except the ones given, as a live service would. */
  function build(opts: { without?: string[]; extra?: Route[]; meta?: Record<string, Record<string, unknown>>; metaDown?: boolean; probeDown?: boolean; probes?: Record<string, unknown> } = {}) {
    const skip = new Set(opts.without ?? []);
    const routes: Route[] = [
      ...Object.keys(API_CATALOG)
        .filter((k) => !skip.has(k) && !(API_CATALOG[k as keyof typeof API_CATALOG] as { workerOnly?: boolean }).workerOnly)
        .map((k) => route(k, k.includes("/api/admin") ? ["AdminGuard"] : k.startsWith("GET /plans") || k.startsWith("GET /health") ? [] : ["FirebaseAuthGuard"])),
      ...(opts.extra ?? []),
    ];
    const checkCached = jest.fn(async () => {
      if (opts.probeDown) throw new Error("probe crashed");
      return {
        generatedAt: NOW.toISOString(),
        vendors: [{ name: "Polygon", online: true, keyPresent: true }],
        endpoints: Object.entries(opts.probes ?? {}).map(([k, probe]) => ({ ...route(k, []), probe })),
      };
    });
    const health = { listEndpoints: () => routes, checkCached };
    const meta = {
      statusAll: async () => {
        if (opts.metaDown) throw new Error("firestore down");
        return Object.entries(opts.meta ?? {}).map(([job, m]) => ({ job, ...m }));
      },
    };
    const config = { get: (_k: string, d: string) => d };
    return { svc: new ScreenApiService(health as never, meta as never, config as never), checkCached };
  }

  const healthy = { lastSyncedAt: "2026-10-30T14:00:00Z", lastStatus: "ok" };

  it("reports every catalogued API and every screen", async () => {
    const { svc } = build();
    const rep = await svc.report({}, NOW);
    expect(rep.counts.apis).toBe(Object.keys(API_CATALOG).length);
    expect(rep.counts.screens).toBe(SCREENS.length);
    expect(Object.keys(rep.apis)).toHaveLength(rep.counts.apis);
    expect(rep.screens.every((s) => s.apiKeys.every((k) => rep.apis[k]))).toBe(true);
    expect(rep.groups[0]).toBe("Shared");
    expect(rep.vendors).toEqual([{ name: "Polygon", online: true, keyPresent: true }]);
  });

  it("takes access levels from the route table, not from the catalogue", async () => {
    const rep = await build().svc.report({}, NOW);
    expect(rep.apis["GET /market-data/companies"].auth).toBe("login");
    expect(rep.apis["GET /api/admin/jobs"].auth).toBe("admin");
    expect(rep.apis["GET /plans"].auth).toBe("public");
  });

  it("marks a catalogued route the service lacks missing, and a worker-only one unknown", async () => {
    const rep = await build({ without: ["GET /market-data/ipos"] }).svc.report({}, NOW);
    expect(rep.apis["GET /market-data/ipos"]).toMatchObject({ registered: false, status: "missing", auth: null });
    expect(rep.apis["POST /sync/:job/run"]).toMatchObject({ registered: false, workerOnly: true, status: "unknown" });
    expect(rep.screens.find((s) => s.id === "ipos").status).toBe("missing");
  });

  it("lists routes the service has that the catalogue does not", async () => {
    const rep = await build({ extra: [route("POST /api/brand-new", ["FirebaseAuthGuard"])] }).svc.report({}, NOW);
    expect(rep.undocumented).toEqual([
      { key: "POST /api/brand-new", method: "POST", path: "/api/brand-new", controller: "FakeController", auth: "login" },
    ]);
    expect(rep.counts.undocumented).toBe(1);
  });

  it("degrades an API — and the screens that use it — when the job feeding it is failing", async () => {
    // Heatmap reads companies (company-quotes) and sectors; movers is not one of its inputs.
    const { svc } = build({ meta: { "market-movers": { lastSyncedAt: "2026-10-30T14:00:00Z", lastStatus: "error", lastError: "FMP 503" }, sectors: healthy, "company-quotes": healthy } });
    const rep = await svc.report({}, NOW);
    expect(rep.apis["GET /market-data/movers"]).toMatchObject({ status: "degraded" });
    expect(rep.apis["GET /market-data/movers"].producers[0]).toMatchObject({ job: "market-movers", health: "failing", lastError: "FMP 503" });
    expect(rep.apis["GET /market-data/sectors"].status).toBe("ok");
    expect(rep.screens.find((s) => s.id === "movers").status).toBe("degraded");
    expect(rep.screens.find((s) => s.id === "heatmap").status).toBe("ok"); // untouched by the movers failure
  });

  it("uses a probe result when there is one", async () => {
    const { svc } = build({ meta: { sectors: healthy }, probes: { "GET /plans": { status: 200, ok: true, up: true, ms: 33 }, "GET /live/tape": { status: 500, ok: false, up: false, ms: 70, error: "boom" } } });
    const rep = await svc.report({}, NOW);
    expect(rep.apis["GET /plans"]).toMatchObject({ status: "ok", probe: { state: "ok", ms: 33 } });
    expect(rep.apis["GET /live/tape"]).toMatchObject({ status: "down" });
    expect(rep.screens.find((s) => s.id === "dashboard").status).toBe("down");
  });

  it("does not turn unreadable run history into a wall of degraded APIs", async () => {
    const rep = await build({ metaDown: true }).svc.report({}, NOW);
    expect(rep.metaError).toBe("firestore down");
    expect(rep.apis["GET /market-data/movers"].status).toBe("unknown");
    expect(rep.counts.byStatus.degraded).toBe(0);
  });

  it("carries on, and says so, when the probe itself fails", async () => {
    const rep = await build({ probeDown: true, meta: { sectors: healthy } }).svc.report({}, NOW);
    expect(rep.probeError).toBe("probe crashed");
    expect(rep.apis["GET /market-data/sectors"].status).toBe("ok"); // producers still speak
    expect(rep.apis["GET /market-data/sectors"].probe.state).toBe("unavailable");
  });

  it("re-probes only when asked, otherwise reuses a recent report", async () => {
    const { svc, checkCached } = build();
    await svc.report({}, NOW);
    expect(checkCached).toHaveBeenLastCalledWith(60_000, false);
    await svc.report({ fresh: true }, NOW);
    expect(checkCached).toHaveBeenLastCalledWith(60_000, true);
  });

  it("tells the browser which APIs it may exercise, and why not for the rest", async () => {
    const rep = await build().svc.report({}, NOW);
    expect(rep.apis["GET /market-data/sectors"].check).toEqual({ url: "/market-data/sectors" });
    expect(rep.apis["GET /live/company"].check).toEqual({ url: "/live/company?ticker=AAPL" });
    expect(rep.apis["POST /api/portfolio/holdings"].check).toEqual({ skip: "changes data" });
    expect(rep.apis["GET /live/ai-analysis"].check).toMatchObject({ skip: expect.stringMatching(/LLM/) });
  });

  it("records which screens call each API, and which call none", async () => {
    const rep = await build().svc.report({}, NOW);
    expect(rep.apis["GET /market-data/movers"].screens.sort()).toEqual(["dashboard", "movers"]);
    expect(rep.apis["GET /live/ownership-13dg"].screens).toEqual([]);
    expect(rep.counts.unusedApis).toBeGreaterThan(0);
  });
});
