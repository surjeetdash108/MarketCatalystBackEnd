import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { jobManifest, JOB_MANIFEST } from "../common/job-manifest";
import {
  clearLockIfOwner,
  readLiveLocks,
  type LockInfo,
} from "../common/job-lock.util";
import { assessJob } from "../common/job-schedule.util";
import {
  assessActivity,
  jobFeeds,
  jobRole,
  jobWrites,
} from "./job-activity";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import {
  DispatchError,
  describeRunner,
  pickDispatcher,
  readJobRunnerConfig,
  type DispatcherDeps,
  type JobRunnerConfig,
  type RunnerStatus,
} from "./job-dispatch";
import {
  ADMIN_JOB_RUNS_COLLECTION,
  IN_FLIGHT_STATUSES,
  toRunView,
  type AdminJobRun,
} from "./job-runs";

/** How many manual runs may be queued or running at once, across all jobs. */
export const MAX_RUNS_IN_FLIGHT = 3;

const DEFAULT_RUNS_LIMIT = 25;
const MAX_RUNS_LIMIT = 100;
/** How far back the inventory looks for each job's latest manual run. */
const INVENTORY_RUNS_WINDOW = 50;

/**
 * A lease that was taken before the job's last recorded run is a lease whose run
 * has finished: the job writes sync_meta when it ends, so a `lastSyncedAt` at or
 * after `acquiredAt` means the run that took the lease is over.
 *
 * This matters because the scheduler's HTTP path takes a 30-minute lease and
 * never releases it (sync.controller.ts, the inline branch of run()). Left
 * alone, that makes every manual run of a frequently-scheduled job fail with
 * "already running" for up to half an hour after its last run, when nothing is
 * running at all. Whether a lease is stale is therefore worth telling the admin
 * — but only the admin may clear it, and only when this says so.
 */
export function isLeaseStale(
  lock: Pick<LockInfo, "acquiredAt">,
  meta: { lastSyncedAt?: unknown } | undefined,
): boolean {
  const recorded =
    typeof meta?.lastSyncedAt === "string" ? Date.parse(meta.lastSyncedAt) : NaN;
  return Number.isFinite(recorded) && recorded >= lock.acquiredAt;
}

export interface RunRequest {
  /** For a destructive job: the job's name, typed by the admin. */
  confirm?: unknown;
  /** The admin saw the lease was stale and wants it cleared to proceed. */
  clearStaleLock?: unknown;
}

function failure(
  status: HttpStatus,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException(
    {
      statusCode: status,
      error: HttpStatus[status] ?? "Error",
      code,
      message,
      timestamp: new Date().toISOString(),
      ...extra,
    },
    status,
  );
}

const iso = (ms: number): string => new Date(ms).toISOString();

@Injectable()
export class JobsAdminService {
  private readonly logger = new Logger(JobsAdminService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly config: ConfigService,
  ) {}

  /** Which transport "run now" would use here, or why there is none. */
  runnerStatus(): RunnerStatus {
    try {
      return describeRunner(this.dispatcherDeps(this.runnerConfig()));
    } catch (err) {
      return {
        available: false,
        transport: null,
        target: null,
        reason: (err as Error).message,
      };
    }
  }

  private runnerConfig(): JobRunnerConfig | null {
    return readJobRunnerConfig(this.config);
  }

  private dispatcherDeps(runnerConfig: JobRunnerConfig | null): DispatcherDeps {
    return {
      registry: this.registry,
      runnerConfig,
      inProcess: {
        registry: this.registry,
        firestore: () => this.firebase.firestore,
        readMeta: async (job) =>
          (await this.meta.status(job)) as Record<string, unknown>,
      },
      getAccessToken: () => this.firebase.getAccessToken(),
      identity: this.firebase.describeIdentity(),
    };
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  async recentRuns(
    limit: number = DEFAULT_RUNS_LIMIT,
    now: number = Date.now(),
  ): Promise<AdminJobRun[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit) || DEFAULT_RUNS_LIMIT, 1), MAX_RUNS_LIMIT);
    const snap = await this.firebase.firestore
      .collection(ADMIN_JOB_RUNS_COLLECTION)
      .orderBy("requestedAt", "desc")
      .limit(bounded)
      .get();
    return snap.docs.map((d) =>
      toRunView(d.id, d.data() as Record<string, unknown>, now),
    );
  }

  /**
   * Job + scheduler inventory for the Jobs tab. Served from the LIVE service,
   * which has no SyncRegistry: JOB_MANIFEST is plain data, and run history,
   * leases and manual runs are Firestore collections it can read directly.
   *
   * Every Firestore read is independent and optional — a failure is reported in
   * its own `*Error` field and the manifest is still returned, because knowing
   * what should run is useful even when the history cannot be read.
   */
  async inventory(now: Date = new Date()) {
    let metaByJob = new Map<string, Record<string, unknown>>();
    let metaError: string | null = null;
    try {
      metaByJob = new Map(
        (await this.meta.statusAll()).map((m) => [m.job, m as Record<string, unknown>]),
      );
    } catch (err) {
      metaError = (err as Error).message;
    }

    let locks = new Map<string, LockInfo>();
    let lockError: string | null = null;
    try {
      locks = await readLiveLocks(this.firebase.firestore, now.getTime());
    } catch (err) {
      lockError = (err as Error).message;
    }

    let runs: AdminJobRun[] = [];
    let runsError: string | null = null;
    try {
      runs = await this.recentRuns(INVENTORY_RUNS_WINDOW, now.getTime());
    } catch (err) {
      runsError = (err as Error).message;
    }
    // `runs` is newest first, so the first one seen per job is its latest.
    const lastRunByJob = new Map<string, AdminJobRun>();
    for (const run of runs) if (!lastRunByJob.has(run.job)) lastRunByJob.set(run.job, run);

    const jobs = JOB_MANIFEST.map((entry) => {
      const m = metaByJob.get(entry.name);
      const assessment = assessJob(entry, m, now);
      const lock = locks.get(entry.name);
      const lastRun = lastRunByJob.get(entry.name);
      const feeds = jobFeeds(entry.name);
      return {
        role: jobRole(entry.name),
        feeds,
        writes: jobWrites(feeds, m),
        activity: assessActivity({
          name: entry.name,
          lock,
          leaseStale: !!lock && isLeaseStale(lock, m),
          adminRun: lastRun,
          metaByJob,
          now: now.getTime(),
        }),
        name: entry.name,
        trigger: entry.trigger,
        schedules: entry.schedules,
        note: entry.note ?? null,
        timeZone: assessment.timeZone,
        nextRunAt: assessment.nextRunAt,
        health: assessment.health,
        expectedBy: assessment.expectedBy,
        risk: entry.risk ?? null,
        lastSyncedAt: (m?.lastSyncedAt as string | null) ?? null,
        lastStatus: (m?.lastStatus as string | null) ?? null,
        lastCount: (m?.lastCount as number | null) ?? null,
        lastError: (m?.lastError as string | null) ?? null,
        lastSuccessAt: (m?.lastSuccessAt as string | null) ?? null,
        lastFailedAt: (m?.lastFailedAt as string | null) ?? null,
        runCount: (m?.runCount as number | null) ?? null,
        errorCount: (m?.errorCount as number | null) ?? null,
        lock: lock
          ? {
              heldUntil: iso(lock.expiresAt),
              acquiredAt: iso(lock.acquiredAt),
              owner: lock.owner,
              probablyStale: isLeaseStale(lock, m),
            }
          : null,
        lastAdminRun: lastRun ?? null,
      };
    });

    const inFlight = (j: (typeof jobs)[number]) => j.activity !== null;

    const counts = {
      total: jobs.length,
      scheduler: jobs.filter((j) => j.trigger === "scheduler").length,
      premarket: jobs.filter((j) => j.trigger === "premarket").length,
      none: jobs.filter((j) => j.trigger === "none").length,
      failing: jobs.filter((j) => j.health === "failing").length,
      late: jobs.filter((j) => j.health === "late").length,
      neverRun: jobs.filter((j) => !j.lastSyncedAt).length,
      running: jobs.filter(inFlight).length,
    };

    return {
      jobs,
      counts,
      runner: this.runnerStatus(),
      metaError,
      lockError,
      runsError,
      generatedAt: now.toISOString(),
    };
  }

  // ── Running ───────────────────────────────────────────────────────────────

  /**
   * Starts a job on behalf of the admin. Everything that can say no does so
   * before anything is started, in this order: the name must be in the
   * manifest, a destructive job needs its name typed, a transport must exist,
   * the job's lease must be free (or provably stale and the admin said to clear
   * it), and the in-flight limits must allow it. The last two are checked
   * together with creating the audit record, in one transaction, so two clicks
   * cannot both get through.
   */
  async requestRun(
    jobName: string,
    requestedBy: string,
    request: RunRequest = {},
    now: Date = new Date(),
  ): Promise<{ run: AdminJobRun; message: string }> {
    const entry = jobManifest(jobName);
    if (!entry) {
      throw failure(HttpStatus.NOT_FOUND, "UNKNOWN_JOB", `There is no job named "${jobName}".`);
    }
    if (entry.risk?.level === "destructive" && request.confirm !== entry.name) {
      throw failure(
        HttpStatus.BAD_REQUEST,
        "CONFIRM_REQUIRED",
        `"${entry.name}" deletes data. Type its name to confirm.`,
        { risk: entry.risk },
      );
    }

    let runnerConfig: JobRunnerConfig | null;
    try {
      runnerConfig = this.runnerConfig();
    } catch (err) {
      throw failure(HttpStatus.SERVICE_UNAVAILABLE, "RUNNER_MISCONFIGURED", (err as Error).message);
    }
    const dispatcher = pickDispatcher(entry.name, this.dispatcherDeps(runnerConfig));
    if (!dispatcher) {
      throw failure(
        HttpStatus.SERVICE_UNAVAILABLE,
        "RUNNER_NOT_CONFIGURED",
        this.runnerStatus().reason ?? "Run now is not set up on this service.",
      );
    }

    const firestore = this.firebase.firestore;
    // Read-only: refuses a live lease, or a stale one the admin has not agreed
    // to clear. Nothing is changed until the limits below have passed too.
    const staleLease = await this.inspectLease(
      entry.name,
      request.clearStaleLock === true,
      now,
    );
    const clearedStaleLock = staleLease !== null;

    const runs = firestore.collection(ADMIN_JOB_RUNS_COLLECTION);
    const ref = runs.doc();
    const record = {
      job: entry.name,
      status: "queued",
      transport: dispatcher.transport,
      requestedBy,
      requestedAt: now.toISOString(),
      startedAt: null,
      finishedAt: null,
      executionName: null,
      attempt: null,
      clearedStaleLock,
      summary: null,
      error: null,
    };

    await firestore.runTransaction(async (tx) => {
      const inFlight = (
        await tx.get(runs.where("status", "in", IN_FLIGHT_STATUSES))
      ).docs
        .map((d) => toRunView(d.id, d.data() as Record<string, unknown>, now.getTime()))
        // "lost" runs are old debris, not capacity in use.
        .filter((r) => IN_FLIGHT_STATUSES.includes(r.status));
      const same = inFlight.find((r) => r.job === entry.name);
      if (same) {
        throw failure(
          HttpStatus.CONFLICT,
          "ALREADY_REQUESTED",
          `"${entry.name}" was already requested by ${same.requestedBy} and has not finished.`,
          { run: same },
        );
      }
      if (inFlight.length >= MAX_RUNS_IN_FLIGHT) {
        throw failure(
          HttpStatus.TOO_MANY_REQUESTS,
          "TOO_MANY_RUNS",
          `${inFlight.length} manual runs are already in flight (${inFlight
            .map((r) => r.job)
            .join(", ")}). Wait for one to finish.`,
        );
      }
      tx.set(ref, record);
    });

    this.logger.log(
      `${requestedBy} requested a manual run of "${entry.name}" ` +
        `(run ${ref.id}, ${dispatcher.transport}${clearedStaleLock ? ", stale lease cleared" : ""})`,
    );

    try {
      if (staleLease) {
        const cleared = await clearLockIfOwner(firestore, entry.name, staleLease.owner);
        if (!cleared) {
          // Between the read and the delete the lease changed hands, so it is
          // no longer the stale one the admin approved clearing.
          throw new DispatchError(
            `"${entry.name}" started running while you were deciding — its lease changed hands.`,
            "LOCKED",
          );
        }
      }
      const { executionName } = await dispatcher.dispatch({ job: entry.name, runId: ref.id });
      if (executionName) await ref.update({ executionName });
    } catch (err) {
      const reason = err instanceof DispatchError ? err : null;
      const message = (err as Error).message;
      this.logger.error(`dispatch of "${entry.name}" (run ${ref.id}) failed: ${message}`);
      await ref
        .update({
          status: "dispatch-failed",
          finishedAt: new Date().toISOString(),
          error: message.slice(0, 400),
        })
        .catch(() => undefined);
      throw failure(
        reason?.code === "LOCKED"
          ? HttpStatus.CONFLICT
          : reason?.code === "UPSTREAM"
            ? HttpStatus.BAD_GATEWAY
            : HttpStatus.SERVICE_UNAVAILABLE,
        reason?.code === "LOCKED" ? "JOB_LOCKED" : "DISPATCH_FAILED",
        message,
        { runId: ref.id },
      );
    }

    const created = (await ref.get()).data() as Record<string, unknown> | undefined;
    return {
      run: toRunView(ref.id, created ?? record, now.getTime()),
      message:
        dispatcher.transport === "cloud-run-job"
          ? `Started "${entry.name}" on ${dispatcher.target}. It reports back here as it runs.`
          : `Started "${entry.name}" in ${dispatcher.target}.`,
    };
  }

  /**
   * Looks at the job's lease WITHOUT changing it. Returns the stale lease the
   * admin has agreed to clear (the caller clears it once nothing else can
   * refuse the run), or null when there is nothing to clear. A lease whose state
   * cannot be read never blocks: the job takes its own lease when it starts,
   * which is the real guard, so a Firestore hiccup here must not stop the admin.
   */
  private async inspectLease(
    job: string,
    clearStale: boolean,
    now: Date,
  ): Promise<LockInfo | null> {
    let lock: LockInfo | undefined;
    try {
      lock = (await readLiveLocks(this.firebase.firestore, now.getTime())).get(job);
    } catch (err) {
      this.logger.warn(`could not read the lease for "${job}": ${(err as Error).message}`);
      return null;
    }
    if (!lock) return null;

    let meta: Record<string, unknown> | undefined;
    try {
      meta = (await this.meta.status(job)) as Record<string, unknown>;
    } catch {
      meta = undefined;
    }
    const detail = {
      lock: {
        heldUntil: iso(lock.expiresAt),
        acquiredAt: iso(lock.acquiredAt),
        owner: lock.owner,
      },
    };

    if (!isLeaseStale(lock, meta)) {
      throw failure(
        HttpStatus.CONFLICT,
        "JOB_LOCKED",
        `"${job}" is running now — its lease is held until ${iso(lock.expiresAt)}.`,
        detail,
      );
    }
    if (!clearStale) {
      throw failure(
        HttpStatus.CONFLICT,
        "JOB_LOCK_STALE",
        `"${job}" is not running, but a finished run left its lease in place until ${iso(
          lock.expiresAt,
        )}, which blocks a new run. Clearing a lease that is provably stale is safe.`,
        detail,
      );
    }
    return lock;
  }
}
