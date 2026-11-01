import {
  PREMARKET_JOBS,
  PREMARKET_PHASE_GROUPS,
  PREMARKET_WARM,
} from "../common/premarket-phases";
import type { LockInfo } from "../common/job-lock.util";
import { jobManifest } from "../common/job-manifest";
import { API_DOCS, SCREENS } from "./screen-api.registry";
import { IN_FLIGHT_STATUSES, type AdminJobRun } from "./job-runs";

/**
 * What the admin Jobs tab says about a job beyond its schedule: what it is
 * (where it sits, what it writes, what reads it) and what it is doing right now.
 *
 * Everything here is derived from data that already exists — the premarket phase
 * lists, the API/screen catalogue, sync_meta, job leases and manual-run records —
 * so nothing is a hand-written description that could drift from the code. Where
 * a fact cannot be known (a job that reports no progress while it runs), the
 * result says so instead of guessing.
 */

// ── what it is ───────────────────────────────────────────────────────────────

export interface JobRole {
  /** Set when the job runs as a step of the premarket bundle. */
  partOf: string | null;
  /** Where in the bundle it sits (null when it is not one of its steps). */
  step: {
    group: string;
    /** 1-based position among the bundle's jobs (the warm step is step 0). */
    position: number;
    of: number;
    after: string | null;
    before: string | null;
  } | null;
  /** For the premarket job itself: every step in order, warm step first. */
  steps: Array<{ name: string; group: string; label: string }> | null;
}

export function jobRole(name: string): JobRole {
  if (name === "premarket") {
    const steps = [
      { name: PREMARKET_WARM, group: "Warm", label: "Warm hot tickers" },
      ...PREMARKET_PHASE_GROUPS.flatMap((g) =>
        g.jobs.map((job) => ({ name: job, group: g.label, label: job })),
      ),
    ];
    return { partOf: null, step: null, steps };
  }
  const at = PREMARKET_JOBS.indexOf(name);
  if (at < 0) return { partOf: null, step: null, steps: null };
  const group = PREMARKET_PHASE_GROUPS.find((g) => g.jobs.includes(name));
  return {
    partOf: "premarket",
    step: {
      group: group?.label ?? "",
      position: at + 1,
      of: PREMARKET_JOBS.length,
      after: at > 0 ? PREMARKET_JOBS[at - 1] : null,
      before: at < PREMARKET_JOBS.length - 1 ? PREMARKET_JOBS[at + 1] : null,
    },
    steps: null,
  };
}

export interface JobFeed {
  api: string;
  summary: string;
  /** "feeds" when the API's status follows this job; "also" when it merely writes there too. */
  relation: "feeds" | "also";
  screens: Array<{ id: string; label: string }>;
}

/** The APIs (and through them the screens) whose data this job writes. */
export function jobFeeds(name: string): JobFeed[] {
  const screensFor = (key: string) =>
    SCREENS.filter((s) => (s.apis as readonly string[]).includes(key)).map(
      (s) => ({ id: s.id, label: s.label }),
    );
  const out: JobFeed[] = [];
  for (const doc of API_DOCS) {
    const relation = doc.producers?.includes(name)
      ? "feeds"
      : doc.alsoWrittenBy?.includes(name)
        ? "also"
        : null;
    if (relation) {
      out.push({
        api: doc.key,
        summary: doc.summary,
        relation,
        screens: screensFor(doc.key),
      });
    }
  }
  return out;
}

/**
 * Collections the job writes: what the job itself registered (recorded in its
 * sync_meta) plus the stores of the APIs it feeds, de-duplicated. The registry's
 * placeholder entries (such as "(orchestrates all sync jobs)") are kept — they
 * say something true about the job.
 */
export function jobWrites(
  feeds: JobFeed[],
  meta: { collections?: unknown } | undefined,
): string[] {
  const set = new Set<string>();
  if (Array.isArray(meta?.collections)) {
    for (const c of meta.collections) if (typeof c === "string") set.add(c);
  }
  for (const feed of feeds) {
    if (feed.relation !== "feeds") continue;
    const doc = API_DOCS.find((d) => d.key === feed.api);
    for (const store of doc?.store ?? []) set.add(store);
  }
  return [...set];
}

// ── what it is doing ─────────────────────────────────────────────────────────

export type StepState = "done" | "failed" | "running" | "waiting";

export interface ActivityStep {
  name: string;
  group: string;
  state: StepState;
  finishedAt: string | null;
  /**
   * The step also has a scheduler entry of its own, so a record newer than this
   * run's start may come from that schedule instead of from this run.
   */
  ownSchedule: boolean;
}

export interface JobActivity {
  state: "running" | "starting";
  startedAt: string | null;
  elapsedMs: number | null;
  /** Who or what started the run, as far as can be told. */
  startedBy:
    | { kind: "admin"; by: string }
    | { kind: "lease"; owner: string }
    | { kind: "unknown" };
  /** The lease is the run's own deadline: past it, the run is presumed dead. */
  leaseUntil: string | null;
  /** The newest manual run's id, when this run was started from the tab. */
  runId: string | null;
  /**
   * Step-by-step progress, for the jobs that have steps (premarket). It is
   * inferred from each step's own last record — "finished since this run began"
   * — because the bundle does not report progress while it runs.
   */
  steps: ActivityStep[] | null;
  /** The step in progress, or the one that would start next. */
  current: string | null;
  /** What the admin can and cannot know about this run right now. */
  note: string;
}

interface Meta {
  lastSyncedAt?: unknown;
  lastStatus?: unknown;
}

const finishedMs = (m: Meta | undefined): number => {
  const t = typeof m?.lastSyncedAt === "string" ? Date.parse(m.lastSyncedAt) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/** Progress of a premarket run that began at `startedAt` (epoch ms). */
export function premarketProgress(
  startedAt: number,
  metaByJob: Map<string, Meta>,
): { steps: ActivityStep[]; current: string | null } {
  const steps: ActivityStep[] = [];
  let anyDone = false;
  for (const g of PREMARKET_PHASE_GROUPS) {
    for (const name of g.jobs) {
      const m = metaByJob.get(name);
      const at = finishedMs(m);
      const ranSince = Number.isFinite(at) && at >= startedAt;
      const state: StepState = !ranSince
        ? "waiting"
        : m?.lastStatus === "error"
          ? "failed"
          : "done";
      if (ranSince) anyDone = true;
      steps.push({
        name,
        group: g.label,
        state,
        finishedAt: ranSince ? new Date(at).toISOString() : null,
        ownSchedule: jobManifest(name)?.trigger === "scheduler",
      });
    }
  }
  // The warm step has no record of its own; it is over once any later step is.
  const warm: ActivityStep = {
    name: PREMARKET_WARM,
    group: "Warm",
    state: anyDone ? "done" : "running",
    finishedAt: null,
    ownSchedule: false,
  };
  const all = [warm, ...steps];
  const next = all.find((s) => s.state === "waiting" || s.state === "running");
  if (next && next.state === "waiting") next.state = "running";
  return { steps: all, current: next?.name ?? null };
}

export function assessActivity(input: {
  name: string;
  lock: Pick<LockInfo, "owner" | "acquiredAt" | "expiresAt"> | undefined;
  /** The lease belongs to a run that has already finished. */
  leaseStale: boolean;
  adminRun: AdminJobRun | undefined;
  metaByJob: Map<string, Meta>;
  now: number;
}): JobActivity | null {
  const { name, lock, leaseStale, adminRun, metaByJob, now } = input;
  const liveLease = !!lock && !leaseStale;
  const adminInFlight =
    !!adminRun && IN_FLIGHT_STATUSES.includes(adminRun.status);
  if (!liveLease && !adminInFlight) return null;

  const startedAtMs = liveLease
    ? lock!.acquiredAt
    : adminRun?.startedAt
      ? Date.parse(adminRun.startedAt)
      : NaN;
  const known = Number.isFinite(startedAtMs);
  // A manual run counts as "starting" until the job has taken its lease.
  const state: JobActivity["state"] = liveLease ? "running" : "starting";

  const startedBy: JobActivity["startedBy"] = adminInFlight
    ? { kind: "admin", by: adminRun!.requestedBy }
    : liveLease
      ? { kind: "lease", owner: lock!.owner }
      : { kind: "unknown" };

  let steps: ActivityStep[] | null = null;
  let current: string | null = null;
  let note: string;
  if (name === "premarket" && known) {
    const p = premarketProgress(startedAtMs, metaByJob);
    steps = p.steps;
    current = p.current;
    note =
      "The bundle does not report progress while it runs. A step is marked done when its own last record is newer than this run's start; steps that also run on their own schedule are flagged, because their record may come from that schedule.";
  } else if (state === "starting") {
    note =
      "Requested from this tab; the job has not taken its lease yet, so it may still be starting up.";
  } else {
    note =
      "This job reports no progress while it runs; it records its result when it finishes. The lease below is its deadline.";
  }

  return {
    state,
    startedAt: known ? new Date(startedAtMs).toISOString() : null,
    elapsedMs: known ? Math.max(0, now - startedAtMs) : null,
    startedBy,
    leaseUntil: liveLease ? new Date(lock!.expiresAt).toISOString() : null,
    runId: adminRun?.id ?? null,
    steps,
    current,
    note,
  };
}
