import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { jobManifest } from "../common/job-manifest";
import { assessJob, type JobHealth } from "../common/job-schedule.util";
import { SyncMetaService } from "../common/sync-meta.service";
import {
  ApiHealthService,
  type EndpointProbe,
  type ApiHealthReport,
} from "./api-health.service";
import {
  API_DOCS,
  SCREEN_GROUPS,
  SCREENS,
  checkRequest,
  screensByApi,
  type ApiDoc,
} from "./screen-api.registry";

/**
 * Joins the screen/API catalogue (screen-api.registry.ts) with what the running
 * service can actually say about each API, for the admin "API Docs" tab.
 *
 * What "status" means, and what it does not
 * -----------------------------------------
 * Three independent signals, each reported with its reason:
 *
 *  1. Is the route registered on THIS service? Read from the live route table,
 *     not from the catalogue, so a deploy that lacks a route — or a catalogue
 *     that names one that was renamed — shows up as "missing".
 *  2. Did the health probe reach it? The existing probe only calls public GETs
 *     that take no parameters (api-health.service.ts), so most routes were
 *     never probed; that is reported as "not probed", never as healthy.
 *  3. Are the jobs that fill its data alive? For the shared lists the live
 *     service never calls a vendor — it serves only what a sync job wrote — so
 *     an API is exactly as fresh as its producers. A failing, late or
 *     never-run producer degrades it.
 *
 * "ok" therefore means "nothing known is wrong", and "unknown" means nothing is
 * known at all (typically a route that needs a signed-in user). Vendor
 * reachability is shown for context but does not change a status: most routes
 * fall back between vendors, so one being offline does not mean the route is.
 */

export type ApiStatus = "ok" | "degraded" | "down" | "missing" | "unknown";
export type AuthLevel = "public" | "login" | "admin" | "mcp-key";

export type ProbeSummary =
  | { state: "ok"; status: number; ms: number }
  | { state: "reachable"; status: number; ms: number }
  | { state: "down"; status: number; ms: number; error?: string }
  | { state: "not-probed"; reason: string }
  | { state: "unavailable"; reason: string };

export interface ProducerState {
  job: string;
  /** "unknown": run history could not be read, so freshness is not judged. */
  health: JobHealth | "unknown";
  lastSyncedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  expectedBy: string | null;
}

/** What the guards on a route mean to a caller. */
export function authLevel(guards: readonly string[]): AuthLevel {
  if (guards.includes("AdminGuard")) return "admin";
  if (guards.includes("McpApiKeyGuard")) return "mcp-key";
  if (guards.includes("FirebaseAuthGuard")) return "login";
  // DelistedTickerGuard only rejects a delisted ?ticker=; it is not a login.
  return "public";
}

export function summariseProbe(
  probe: ApiHealthReport["endpoints"][number]["probe"] | undefined,
): ProbeSummary {
  if (!probe) return { state: "not-probed", reason: "not in the probe report" };
  if ("skipped" in probe) return { state: "not-probed", reason: probe.reason };
  const p = probe as EndpointProbe;
  if (p.ok) return { state: "ok", status: p.status, ms: p.ms };
  if (p.up) return { state: "reachable", status: p.status, ms: p.ms };
  return { state: "down", status: p.status, ms: p.ms, error: p.error };
}

export interface StatusInput {
  registered: boolean;
  workerOnly: boolean;
  probe: ProbeSummary;
  producers: readonly ProducerState[];
}

const clip = (text: string, max = 160): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Pure: the one place the status rules live. */
export function rollupApiStatus(input: StatusInput): {
  status: ApiStatus;
  reasons: string[];
} {
  if (!input.registered) {
    return input.workerOnly
      ? {
          status: "unknown",
          reasons: ["Served by the private worker only — this service does not mount it."],
        }
      : {
          status: "missing",
          reasons: [
            "Not registered on this service: either this catalogue is out of date, or this deploy lacks the route.",
          ],
        };
  }

  const reasons: string[] = [];
  let status: ApiStatus | null = null;
  const { probe } = input;

  if (probe.state === "down") {
    status = "down";
    reasons.push(
      `Health probe failed: ${probe.error ?? `HTTP ${probe.status}`} (${probe.ms} ms).`,
    );
  } else if (probe.state === "ok") {
    reasons.push(`Health probe: ${probe.status} OK in ${probe.ms} ms.`);
  } else if (probe.state === "reachable") {
    reasons.push(
      `Health probe: reachable — ${probe.status}, because the unattended probe sends no parameters (${probe.ms} ms).`,
    );
  } else if (probe.state === "not-probed") {
    reasons.push(`Not probed: ${probe.reason}.`);
  } else {
    reasons.push(`Health probe unavailable: ${probe.reason}.`);
  }

  const judged = input.producers.filter((p) => p.health !== "unknown");
  if (judged.length < input.producers.length) {
    reasons.push("Run history could not be read, so the freshness of its data is not judged.");
  }
  for (const p of judged) {
    if (p.health === "failing") {
      status ??= "degraded";
      reasons.push(
        `${p.job} failed on its last run${p.lastError ? `: ${clip(p.lastError)}` : "."}`,
      );
    } else if (p.health === "late") {
      status ??= "degraded";
      reasons.push(
        `${p.job} is late — it should have run by ${p.expectedBy ?? "its last scheduled slot"}.`,
      );
    } else if (p.health === "never-run") {
      status ??= "degraded";
      reasons.push(`${p.job} has never recorded a run, so this data may be empty.`);
    }
  }

  if (status === null) {
    const verified = probe.state === "ok" || probe.state === "reachable";
    if (verified || judged.length > 0) {
      status = "ok";
    } else {
      status = "unknown";
      reasons.push(
        "Not monitored: it needs a signed-in user, so nothing checks it unattended. Use Run checks.",
      );
    }
  }
  return { status, reasons };
}

/** A screen is as bad as its worst API, but unknowns do not mask healthy ones. */
export function rollupScreenStatus(statuses: readonly ApiStatus[]): ApiStatus {
  if (statuses.length === 0) return "unknown";
  for (const bad of ["down", "missing", "degraded"] as const) {
    if (statuses.includes(bad)) return bad;
  }
  return statuses.includes("ok") ? "ok" : "unknown";
}

export interface ApiStatusRow {
  key: string;
  method: string;
  path: string;
  summary: string;
  params: string | null;
  sse: boolean;
  store: readonly string[];
  producers: ProducerState[];
  alsoWrittenBy: readonly string[];
  vendors: readonly string[];
  notes: string | null;
  workerOnly: boolean;
  registered: boolean;
  auth: AuthLevel | null;
  controller: string | null;
  probe: ProbeSummary;
  status: ApiStatus;
  reasons: string[];
  /** Screens (ids) that call it; empty means no screen does. */
  screens: string[];
  /** What Run checks sends from the browser, or why it does not. */
  check: { url: string } | { skip: string };
}

export type StatusCounts = Record<ApiStatus, number>;

const emptyCounts = (): StatusCounts => ({
  ok: 0,
  degraded: 0,
  down: 0,
  missing: 0,
  unknown: 0,
});

@Injectable()
export class ScreenApiService {
  private readonly logger = new Logger(ScreenApiService.name);

  constructor(
    private readonly health: ApiHealthService,
    private readonly meta: SyncMetaService,
    private readonly config: ConfigService,
  ) {}

  async report(opts: { fresh?: boolean } = {}, now: Date = new Date()) {
    const routes = this.health.listEndpoints();
    const routeByKey = new Map(
      routes.map((r) => [`${r.method} ${r.path}`, r] as const),
    );

    let probeReport: ApiHealthReport | null = null;
    let probeError: string | null = null;
    try {
      probeReport = await this.health.checkCached(60_000, opts.fresh === true);
    } catch (err) {
      probeError = (err as Error).message;
      this.logger.warn(`health probe unavailable: ${probeError}`);
    }
    const probeByKey = new Map(
      (probeReport?.endpoints ?? []).map(
        (e) => [`${e.method} ${e.path}`, e.probe] as const,
      ),
    );

    let metaByJob = new Map<string, Record<string, unknown>>();
    let metaError: string | null = null;
    try {
      metaByJob = new Map(
        (await this.meta.statusAll()).map((m) => [m.job, m as Record<string, unknown>]),
      );
    } catch (err) {
      metaError = (err as Error).message;
    }

    const producerCache = new Map<string, ProducerState>();
    const producerState = (job: string): ProducerState => {
      const cached = producerCache.get(job);
      if (cached) return cached;
      const entry = jobManifest(job);
      const m = metaByJob.get(job);
      const assessment = entry
        ? assessJob(entry, m, now)
        : null;
      const state: ProducerState = {
        job,
        // A name the manifest does not know cannot be assessed; registry.spec
        // keeps this from happening, so treat it as never having run.
        health: metaError ? "unknown" : (assessment?.health ?? "never-run"),
        lastSyncedAt: (m?.lastSyncedAt as string | null) ?? null,
        lastStatus: (m?.lastStatus as string | null) ?? null,
        lastError: (m?.lastError as string | null) ?? null,
        nextRunAt: assessment?.nextRunAt ?? null,
        expectedBy: assessment?.expectedBy ?? null,
      };
      producerCache.set(job, state);
      return state;
    };

    const users = screensByApi();
    const apis: Record<string, ApiStatusRow> = {};
    for (const doc of API_DOCS) {
      apis[doc.key] = this.row(doc, {
        route: routeByKey.get(doc.key),
        probe: probeError
          ? ({ state: "unavailable", reason: probeError } as ProbeSummary)
          : summariseProbe(probeByKey.get(doc.key)),
        producerState,
        screens: users.get(doc.key) ?? [],
      });
    }

    const screens = SCREENS.map((screen) => {
      const statuses = screen.apis.map((k) => apis[k].status);
      const counts = emptyCounts();
      for (const s of statuses) counts[s] += 1;
      return {
        id: screen.id,
        label: screen.label,
        group: screen.group,
        route: screen.route,
        source: screen.source,
        repo: ("repo" in screen ? screen.repo : undefined) ?? "MarketCatalystUI",
        summary: screen.summary,
        apiKeys: [...screen.apis],
        status: rollupScreenStatus(statuses),
        counts,
      };
    });

    const catalogued = new Set(API_DOCS.map((d) => d.key as string));
    const undocumented = routes
      .filter((r) => !catalogued.has(`${r.method} ${r.path}`))
      .map((r) => ({
        key: `${r.method} ${r.path}`,
        method: r.method,
        path: r.path,
        controller: r.controller,
        auth: authLevel(r.guards),
      }));

    const apiCounts = emptyCounts();
    for (const row of Object.values(apis)) apiCounts[row.status] += 1;

    const role = String(this.config.get("APP_ROLE", "worker")).trim().toLowerCase();
    return {
      service: role === "live" ? "market-catalyst-live" : "market-catalyst-backend",
      role,
      generatedAt: now.toISOString(),
      probeAt: probeReport?.generatedAt ?? null,
      probeError,
      metaError,
      groups: [...SCREEN_GROUPS],
      screens,
      apis,
      undocumented,
      vendors: (probeReport?.vendors ?? []).map((v) => ({
        name: v.name,
        online: v.online,
        keyPresent: v.keyPresent,
      })),
      counts: {
        screens: screens.length,
        apis: API_DOCS.length,
        byStatus: apiCounts,
        undocumented: undocumented.length,
        unusedApis: API_DOCS.filter((d) => !(users.get(d.key)?.length)).length,
      },
    };
  }

  private row(
    doc: ApiDoc,
    ctx: {
      route: ReturnType<ApiHealthService["listEndpoints"]>[number] | undefined;
      probe: ProbeSummary;
      producerState: (job: string) => ProducerState;
      screens: string[];
    },
  ): ApiStatusRow {
    const producers = (doc.producers ?? []).map(ctx.producerState);
    const { status, reasons } = rollupApiStatus({
      registered: ctx.route !== undefined,
      workerOnly: doc.workerOnly === true,
      probe: ctx.probe,
      producers,
    });
    return {
      key: doc.key,
      method: doc.method,
      path: doc.path,
      summary: doc.summary,
      params: doc.params ?? null,
      sse: doc.sse === true,
      store: doc.store ?? [],
      producers,
      alsoWrittenBy: doc.alsoWrittenBy ?? [],
      vendors: doc.vendors ?? [],
      notes: doc.notes ?? null,
      workerOnly: doc.workerOnly === true,
      registered: ctx.route !== undefined,
      auth: ctx.route ? authLevel(ctx.route.guards) : null,
      controller: ctx.route?.controller ?? null,
      probe: ctx.probe,
      status,
      reasons,
      screens: ctx.screens,
      check: checkRequest(doc),
    };
  }
}
