import { Logger } from "@nestjs/common";
import type { Firestore } from "firebase-admin/firestore";

/**
 * Manual job runs requested from the admin Jobs tab.
 *
 * One document per request in `admin_job_runs`, written by the backend's Admin
 * SDK only (the browser never touches Firestore). It is the audit trail — who
 * asked for which job, when, and how it ended — and the only way the tab can
 * show progress, because the run itself happens in a different process (a Cloud
 * Run Job execution) that the live service is not connected to.
 *
 * The execution reports back through reportRunStarted / reportRunFinished,
 * which job-entry.ts calls when ADMIN_RUN_ID is set. Scheduled runs never set
 * it, so this is invisible to them.
 */

export const ADMIN_JOB_RUNS_COLLECTION = "admin_job_runs";

export type AdminRunTransport = "cloud-run-job" | "in-process";

export type AdminRunStatus =
  /** Accepted; the job has not reported that it started. */
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  /** The job ran but declined to do work — see `summary`. */
  | "skipped"
  /** Never started: the Run API (or the in-process start) refused. */
  | "dispatch-failed"
  /** Computed on read, never stored: no end state ever arrived. */
  | "lost";

export const IN_FLIGHT_STATUSES: AdminRunStatus[] = ["queued", "running"];

/**
 * A run still queued/running after this long is reported as "lost". The Cloud
 * Run Job's task timeout is an hour with one retry, so anything older has died
 * without saying so (or is running an image from before it knew how to report).
 */
export const RUN_LOST_AFTER_MS = 2 * 60 * 60_000;

/** Firestore auto-ids: 20 chars of [A-Za-z0-9]. */
const RUN_ID_RE = /^[A-Za-z0-9]{20}$/;

export function isValidRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_RE.test(value);
}

/** The shape stored in Firestore and returned to the tab. */
export interface AdminJobRun {
  id: string;
  job: string;
  status: AdminRunStatus;
  transport: AdminRunTransport;
  requestedBy: string;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Cloud Run Job execution id (CLOUD_RUN_EXECUTION), when the transport has one. */
  executionName: string | null;
  /** 0 for the first try; Cloud Run retries a failed task once. */
  attempt: number | null;
  /** The admin cleared a stale lease to make this run possible. */
  clearedStaleLock: boolean;
  /** One line on the outcome: "synced 312 docs", or why it was skipped. */
  summary: string | null;
  error: string | null;
}

/** Normalises a stored document for the API, deriving "lost". */
export function toRunView(
  id: string,
  data: Record<string, unknown> | undefined,
  now: number = Date.now(),
): AdminJobRun {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v ? v : null;
  const status = (str(data?.status) ?? "queued") as AdminRunStatus;
  const requestedAt = str(data?.requestedAt) ?? "";
  const requestedMs = Date.parse(requestedAt);
  const lost =
    IN_FLIGHT_STATUSES.includes(status) &&
    Number.isFinite(requestedMs) &&
    now - requestedMs > RUN_LOST_AFTER_MS;
  return {
    id,
    job: str(data?.job) ?? "",
    status: lost ? "lost" : status,
    transport: (str(data?.transport) ?? "cloud-run-job") as AdminRunTransport,
    requestedBy: str(data?.requestedBy) ?? "unknown",
    requestedAt,
    startedAt: str(data?.startedAt),
    finishedAt: str(data?.finishedAt),
    executionName: str(data?.executionName),
    attempt: typeof data?.attempt === "number" ? data.attempt : null,
    clearedStaleLock: data?.clearedStaleLock === true,
    summary: str(data?.summary),
    error: str(data?.error),
  };
}

export interface RunOutcome {
  status: "succeeded" | "failed" | "skipped";
  summary?: string;
  error?: string;
}

const MAX_TEXT = 400;
const clip = (text: string): string =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;

/** A short, safe rendering of whatever a job's runner returned. */
export function describeResult(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  try {
    const text = typeof result === "string" ? result : JSON.stringify(result);
    return text ? clip(text) : null;
  } catch {
    return null;
  }
}

/**
 * Decides how a run ended.
 *
 * Exit status alone would say "succeeded" for a job that failed: most jobs
 * catch their own errors, record them in sync_meta and RETURN. So the verdict
 * comes from what the job recorded since this run began, falling back to the
 * runner's return value when it recorded nothing (a job that declined to work —
 * "already-published", "automation-disabled" — records no run at all).
 */
export function outcomeFromSyncMeta(
  startedAtMs: number,
  meta: Record<string, unknown> | undefined,
  runnerResult: unknown,
): RunOutcome {
  // The meta write and startedAtMs come from the same process clock, so a small
  // allowance only covers writes that landed in the same millisecond window.
  const recordedMs =
    typeof meta?.lastSyncedAt === "string" ? Date.parse(meta.lastSyncedAt) : NaN;
  if (Number.isFinite(recordedMs) && recordedMs >= startedAtMs - 2_000) {
    if (meta?.lastStatus === "error") {
      return {
        status: "failed",
        error: clip(
          typeof meta.lastError === "string" && meta.lastError
            ? meta.lastError
            : "The job recorded an error.",
        ),
      };
    }
    const count = meta?.lastCount;
    return {
      status: "succeeded",
      summary:
        typeof count === "number" ? `Synced ${count} documents.` : "Completed.",
    };
  }

  const reason =
    runnerResult && typeof runnerResult === "object"
      ? (runnerResult as Record<string, unknown>).reason
      : undefined;
  if (typeof reason === "string" && reason) {
    return { status: "skipped", summary: `The job declined to run: ${reason}.` };
  }
  return {
    status: "succeeded",
    summary:
      describeResult(runnerResult) ??
      "Finished; the job recorded no result of its own.",
  };
}

const logger = new Logger("AdminJobRuns");

/**
 * Run-record writes happen inside a production job. They must never be able to
 * fail it, so both are best-effort: errors are logged and swallowed.
 */
export async function reportRunStarted(
  firestore: Firestore,
  runId: string,
  extra: { executionName?: string | null; attempt?: number | null } = {},
): Promise<void> {
  try {
    await firestore
      .collection(ADMIN_JOB_RUNS_COLLECTION)
      .doc(runId)
      .update({
        status: "running",
        startedAt: new Date().toISOString(),
        // A retry begins a fresh attempt; clear any end state from the first.
        finishedAt: null,
        error: null,
        summary: null,
        ...(extra.executionName ? { executionName: extra.executionName } : {}),
        ...(typeof extra.attempt === "number" ? { attempt: extra.attempt } : {}),
      });
  } catch (err) {
    logger.warn(
      `could not record start of run ${runId}: ${(err as Error).message}`,
    );
  }
}

export async function reportRunFinished(
  firestore: Firestore,
  runId: string,
  outcome: RunOutcome,
): Promise<void> {
  try {
    await firestore
      .collection(ADMIN_JOB_RUNS_COLLECTION)
      .doc(runId)
      .update({
        status: outcome.status,
        finishedAt: new Date().toISOString(),
        summary: outcome.summary ?? null,
        error: outcome.error ?? null,
      });
  } catch (err) {
    logger.warn(
      `could not record end of run ${runId}: ${(err as Error).message}`,
    );
  }
}
