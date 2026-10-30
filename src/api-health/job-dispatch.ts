import { Logger } from "@nestjs/common";
import type { Firestore } from "firebase-admin/firestore";
import { acquireLock, releaseLock } from "../common/job-lock.util";
import type { SyncRegistry } from "../common/sync-registry.service";
import {
  outcomeFromSyncMeta,
  reportRunFinished,
  reportRunStarted,
  type AdminRunTransport,
} from "./job-runs";

/**
 * How a manual run from the admin Jobs tab actually gets started.
 *
 * The console is served by the LIVE role, which deliberately has no SyncModule
 * (app.module.ts): job triggers are left unrouted there so a public service
 * cannot be talked into running one. So "run now" cannot call the job in
 * process, and it cannot go through the worker either — that service is private,
 * scales to zero, and a request to it dies at Cloud Run's request limit (and at
 * Firebase Hosting's 60 s before that).
 *
 * What the architecture already provides for exactly this is the premarket
 * Cloud Run Job: the same image, entrypoint job-entry.js, which runs whichever
 * registered job SYNC_JOB names, to completion, with its own lock and a one-hour
 * task timeout (DEPLOY.md §3c). The live service starts an execution of that job
 * with SYNC_JOB overridden, and the execution reports back through the run
 * record. The only thing the live service needs is permission to start it.
 *
 * Where the registry IS present (the worker role, local development) the job is
 * simply run in process.
 */

export interface DispatchContext {
  job: string;
  runId: string;
}

export interface DispatchResult {
  /** Cloud Run Job execution resource name, when the transport has one. */
  executionName: string | null;
}

export type DispatchErrorCode =
  | "NOT_CONFIGURED"
  | "PERMISSION"
  | "NOT_FOUND"
  | "LOCKED"
  | "UPSTREAM";

export class DispatchError extends Error {
  constructor(
    message: string,
    readonly code: DispatchErrorCode,
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

export interface JobDispatcher {
  readonly transport: AdminRunTransport;
  /** Where the run will happen, in words, for the confirmation dialog. */
  readonly target: string;
  dispatch(ctx: DispatchContext): Promise<DispatchResult>;
}

/** What the Jobs tab needs to know before anyone clicks Run. */
export interface RunnerStatus {
  available: boolean;
  transport: AdminRunTransport | null;
  target: string | null;
  /** Why it is unavailable, as an instruction rather than an error code. */
  reason: string | null;
}

/** Job names are registry keys: lowercase words joined by hyphens. */
export const JOB_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Cloud Run Job transport ─────────────────────────────────────────────────

export interface JobRunnerConfig {
  projectId: string;
  region: string;
  /** The Cloud Run Job to start, e.g. "premarket-job". */
  job: string;
}

const RESOURCE_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

type ConfigReader = { get(key: string): unknown };

/**
 * Enabled by naming the job to start (JOB_RUNNER_JOB). Project and region
 * default to the ones the service already runs in, so a deploy only has to set
 * the one variable. Returns null — "not configured", not an error — when the job
 * is unset, and throws only for a value that cannot be a Cloud Run resource id,
 * which would otherwise be spliced into a URL.
 */
export function readJobRunnerConfig(config: ConfigReader): JobRunnerConfig | null {
  const text = (key: string): string => String(config.get(key) ?? "").trim();
  const job = text("JOB_RUNNER_JOB");
  if (!job) return null;
  const projectId = text("JOB_RUNNER_PROJECT_ID") || text("FIREBASE_PROJECT_ID");
  const region = text("JOB_RUNNER_REGION") || "us-central1";
  if (!RESOURCE_ID_RE.test(job)) {
    throw new Error(`JOB_RUNNER_JOB "${job}" is not a valid Cloud Run Job name.`);
  }
  if (!RESOURCE_ID_RE.test(region)) {
    throw new Error(`JOB_RUNNER_REGION "${region}" is not a valid region.`);
  }
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      "JOB_RUNNER_PROJECT_ID (or FIREBASE_PROJECT_ID) is missing or not a valid project id.",
    );
  }
  return { projectId, region, job };
}

const RUN_API_TIMEOUT_MS = 15_000;

function googleErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message;
  } catch {
    // not JSON — fall through to the raw text
  }
  return body.trim().slice(0, 300) || "(empty response)";
}

export class CloudRunJobDispatcher implements JobDispatcher {
  readonly transport = "cloud-run-job" as const;

  constructor(
    private readonly cfg: JobRunnerConfig,
    private readonly getAccessToken: () => Promise<string>,
    private readonly identity: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get target(): string {
    return `Cloud Run Job ${this.cfg.job} (${this.cfg.region})`;
  }

  async dispatch({ job, runId }: DispatchContext): Promise<DispatchResult> {
    // Defence in depth: the service has already checked the manifest, but this
    // value becomes an environment variable of a production job.
    if (!JOB_NAME_RE.test(job)) {
      throw new DispatchError(`"${job}" is not a job name.`, "NOT_FOUND");
    }
    const { projectId, region, job: runnerJob } = this.cfg;
    const url =
      `https://run.googleapis.com/v2/projects/${projectId}` +
      `/locations/${region}/jobs/${runnerJob}:run`;
    const body = {
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: "SYNC_JOB", value: job },
              { name: "ADMIN_RUN_ID", value: runId },
            ],
          },
        ],
      },
    };

    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err) {
      throw new DispatchError(
        `Could not get a Google access token for ${this.identity}: ${(err as Error).message}`,
        "UPSTREAM",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_API_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw this.mapFailure(res.status, text, token);
      return { executionName: executionNameFrom(text) };
    } catch (err) {
      if (err instanceof DispatchError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new DispatchError(
          `Cloud Run did not answer within ${RUN_API_TIMEOUT_MS / 1000}s.`,
          "UPSTREAM",
        );
      }
      throw new DispatchError(
        `Could not reach the Cloud Run Admin API: ${(err as Error).message}`,
        "UPSTREAM",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private mapFailure(status: number, body: string, token: string): DispatchError {
    // The body is copied into a message that is logged and returned to the
    // browser. An upstream or proxy that reflected our Authorization header
    // would put the bearer token there, so scrub it.
    const detail = googleErrorMessage(body).split(token).join("[redacted]");
    const { projectId, region, job } = this.cfg;
    if (status === 401 || status === 403) {
      return new DispatchError(
        `Cloud Run refused to start "${job}" (HTTP ${status}): ${detail} ` +
          `${this.identity} needs permission to run that job with overrides ` +
          `(run.jobs.runWithOverrides, in roles/run.developer) — see deploy/DEPLOY.md §3d.`,
        "PERMISSION",
      );
    }
    if (status === 404) {
      return new DispatchError(
        `Cloud Run Job "${job}" was not found in project ${projectId}, region ${region}: ${detail}`,
        "NOT_FOUND",
      );
    }
    return new DispatchError(
      `Cloud Run could not start "${job}" (HTTP ${status}): ${detail}`,
      "UPSTREAM",
    );
  }
}

/**
 * Pulls the new execution's id out of the :run response, which is a
 * long-running Operation whose metadata is the Execution
 * ("projects/P/locations/R/jobs/J/executions/J-abcde" -> "J-abcde", the same
 * value the container sees as CLOUD_RUN_EXECUTION). Tolerant of a shape change:
 * the id is a convenience for the run record, never required.
 */
export function executionNameFrom(body: string): string | null {
  try {
    const op = JSON.parse(body) as { metadata?: { name?: unknown } };
    const name = op?.metadata?.name;
    if (typeof name !== "string" || !name) return null;
    return name.split("/").pop() || null;
  } catch {
    return null;
  }
}

// ── In-process transport ────────────────────────────────────────────────────

/** Matches the HTTP path's lease (sync.controller.ts), which this stands in for. */
export const IN_PROCESS_LOCK_TTL_MS = 30 * 60_000;

export interface InProcessDeps {
  registry: Pick<SyncRegistry, "get">;
  firestore: () => Firestore;
  /** sync_meta reader — the same service the jobs record through. */
  readMeta: (job: string) => Promise<Record<string, unknown>>;
  ttlMs?: number;
}

export class InProcessDispatcher implements JobDispatcher {
  readonly transport = "in-process" as const;
  readonly target = "this server process (the worker or local development)";
  private readonly logger = new Logger(InProcessDispatcher.name);

  constructor(private readonly deps: InProcessDeps) {}

  async dispatch({ job, runId }: DispatchContext): Promise<DispatchResult> {
    const runner = this.deps.registry.get(job);
    if (!runner) {
      throw new DispatchError(`"${job}" is not registered in this process.`, "NOT_FOUND");
    }
    const firestore = this.deps.firestore();
    const owner = `admin:${runId}`;
    const got = await acquireLock(firestore, job, {
      ttlMs: this.deps.ttlMs ?? IN_PROCESS_LOCK_TTL_MS,
      ownerId: owner,
    });
    if (!got) {
      throw new DispatchError(
        `"${job}" is already running (its lease is held by another process).`,
        "LOCKED",
      );
    }
    // Detached on purpose: the caller gets its 202 now and polls the run record.
    void this.execute(firestore, job, runId, owner, runner);
    return { executionName: null };
  }

  private async execute(
    firestore: Firestore,
    job: string,
    runId: string,
    owner: string,
    runner: () => Promise<unknown>,
  ): Promise<void> {
    const startedAt = Date.now();
    await reportRunStarted(firestore, runId);
    try {
      const result = await runner();
      let meta: Record<string, unknown> = {};
      try {
        meta = await this.deps.readMeta(job);
      } catch (err) {
        this.logger.warn(`could not read sync_meta for ${job}: ${(err as Error).message}`);
      }
      await reportRunFinished(firestore, runId, outcomeFromSyncMeta(startedAt, meta, result));
    } catch (err) {
      this.logger.error(`manual run of ${job} failed: ${(err as Error).message}`);
      await reportRunFinished(firestore, runId, {
        status: "failed",
        error: (err as Error).message.slice(0, 400),
      });
    } finally {
      await releaseLock(firestore, job, owner);
    }
  }
}

// ── Selection ───────────────────────────────────────────────────────────────

export interface DispatcherDeps {
  registry: Pick<SyncRegistry, "get" | "names">;
  /** null when JOB_RUNNER_JOB is not set. */
  runnerConfig: JobRunnerConfig | null;
  inProcess: InProcessDeps;
  getAccessToken: () => Promise<string>;
  identity: string;
  fetchImpl?: typeof fetch;
}

/**
 * The registry is the test: if this process has the job registered it is the
 * worker (or a developer's machine) and can just run it. The live role registers
 * nothing, so it falls through to the Cloud Run Job.
 */
export function pickDispatcher(job: string, deps: DispatcherDeps): JobDispatcher | null {
  if (deps.registry.get(job)) return new InProcessDispatcher(deps.inProcess);
  if (deps.runnerConfig) {
    return new CloudRunJobDispatcher(
      deps.runnerConfig,
      deps.getAccessToken,
      deps.identity,
      deps.fetchImpl,
    );
  }
  return null;
}

export function describeRunner(deps: DispatcherDeps): RunnerStatus {
  if (deps.registry.names().length > 0) {
    return {
      available: true,
      transport: "in-process",
      target: new InProcessDispatcher(deps.inProcess).target,
      reason: null,
    };
  }
  if (deps.runnerConfig) {
    return {
      available: true,
      transport: "cloud-run-job",
      target: `Cloud Run Job ${deps.runnerConfig.job} (${deps.runnerConfig.region})`,
      reason: null,
    };
  }
  return {
    available: false,
    transport: null,
    target: null,
    reason:
      "Run now is not set up on this service. Set JOB_RUNNER_JOB to the Cloud Run Job that runs sync jobs (premarket-job) and grant this service's account permission to run it — see deploy/DEPLOY.md §3d.",
  };
}
