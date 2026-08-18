import { Logger } from "@nestjs/common";
import type { Firestore } from "firebase-admin/firestore";

/**
 * Distributed job lock backed by a Firestore lease document (P2-7).
 *
 * WHY: sync jobs run as short-lived Cloud Run Job PROCESSES. The in-memory
 * `isRunning` flag in SyncRegistry is per-process and gives zero protection
 * when two processes overlap — a Cloud Scheduler double-fire, or a manual
 * `gcloud run jobs execute premarket-job` launched while the scheduled run is
 * still going. Two concurrent premarket bundles double every vendor call and
 * can interleave writes. A lease document in `job_locks/{jobName}` is the
 * cross-process mutex.
 *
 * LEASE MODEL: a lock is a single doc keyed by job name holding
 * `{ owner, acquiredAt, expiresAt }`. A run "holds" the lock while
 * `expiresAt` is in the future. The TTL means a crashed / OOM-killed holder
 * that never calls releaseLock does NOT block the job forever — the next run
 * after `expiresAt` treats the stale lock as free and takes over. Pick a TTL
 * comfortably above the job's worst-case runtime (this implementation does not
 * renew mid-run), so a still-running holder's lease never lapses under a
 * concurrent run. See JOB_LOCK_TTL_MS wiring in job-entry.ts.
 *
 * The `job_locks` collection is created lazily the first time a job actually
 * runs; no migration or seeding is required.
 */

const logger = new Logger("JobLock");

/** Firestore collection holding one lease doc per job name. */
export const JOB_LOCKS_COLLECTION = "job_locks";

export interface JobLockDoc {
  /** Opaque per-process owner id; only this owner may release the lease. */
  owner: string;
  /** Epoch millis the lease was taken. */
  acquiredAt: number;
  /** Epoch millis the lease expires; a run holds the lock while this is future. */
  expiresAt: number;
  /** Human-readable mirrors of the epoch fields, for eyeballing in the console. */
  acquiredAtIso: string;
  expiresAtIso: string;
}

export interface AcquireLockOptions {
  /** Lease lifetime in millis. Set above the job's worst-case runtime. */
  ttlMs: number;
  /** Unique id for THIS process/run; must match on release. */
  ownerId: string;
}

/**
 * Try to acquire the lease for `jobName`.
 *
 * Returns `true` if we now hold the lease (the doc was missing or its
 * `expiresAt` was already in the past, and we wrote a fresh lease inside a
 * transaction). Returns `false` if a LIVE lease is currently held by another
 * run — the caller should log and SKIP this run.
 *
 * FAIL-OPEN on infra error: if the Firestore transaction itself throws
 * (outage, permission blip, deadline), we log loudly and return `true` so the
 * run PROCEEDS. Rationale: the lock is a guard against the rare double-fire,
 * not a correctness dependency of the syncs themselves; letting a Firestore
 * hiccup on the lock path silently halt every scheduled sync would be a far
 * worse outage than the small risk of one duplicated run. The trade-off is
 * deliberate — a lock-infra failure degrades to "no lock", never to "no sync".
 */
export async function acquireLock(
  firestore: Firestore,
  jobName: string,
  opts: AcquireLockOptions,
): Promise<boolean> {
  const ref = firestore.collection(JOB_LOCKS_COLLECTION).doc(jobName);
  const now = Date.now();
  const expiresAt = now + opts.ttlMs;

  try {
    return await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const data = snap.data() as Partial<JobLockDoc> | undefined;
        const existingExpiry =
          typeof data?.expiresAt === "number" ? data.expiresAt : 0;
        if (existingExpiry > now) {
          // A live lease is held (by another run, or a still-running prior run
          // of us). Do not steal it.
          logger.warn(
            `lock "${jobName}" is held by "${data?.owner ?? "unknown"}" ` +
              `until ${new Date(existingExpiry).toISOString()}; not acquiring.`,
          );
          return false;
        }
        // Stale/expired lease — safe to take over.
        logger.warn(
          `lock "${jobName}" was stale (expired ` +
            `${new Date(existingExpiry).toISOString()}); reclaiming.`,
        );
      }
      const doc: JobLockDoc = {
        owner: opts.ownerId,
        acquiredAt: now,
        expiresAt,
        acquiredAtIso: new Date(now).toISOString(),
        expiresAtIso: new Date(expiresAt).toISOString(),
      };
      tx.set(ref, doc);
      return true;
    });
  } catch (err) {
    // SAFE DEFAULT: proceed without a lock. See docblock — a lock-infra failure
    // must degrade to "no lock", never to "no sync".
    logger.error(
      `acquireLock("${jobName}") errored; PROCEEDING WITHOUT LOCK ` +
        `(safe default): ${(err as Error).message}`,
    );
    return true;
  }
}

/**
 * Release the lease for `jobName`, but only if WE still own it.
 *
 * Ownership is re-checked inside a transaction so we never delete a lease a
 * different run has since taken over (e.g. after our lease expired and another
 * process reclaimed it). Any error here is swallowed and logged: the lease will
 * auto-expire via its TTL, so a failed release never wedges the job.
 */
export async function releaseLock(
  firestore: Firestore,
  jobName: string,
  ownerId: string,
): Promise<void> {
  const ref = firestore.collection(JOB_LOCKS_COLLECTION).doc(jobName);
  try {
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data() as Partial<JobLockDoc> | undefined;
      if (data?.owner === ownerId) {
        tx.delete(ref);
      } else {
        logger.warn(
          `releaseLock("${jobName}") skipped: lease now owned by ` +
            `"${data?.owner ?? "unknown"}", not us ("${ownerId}").`,
        );
      }
    });
  } catch (err) {
    logger.warn(
      `releaseLock("${jobName}") failed (lease will auto-expire via TTL): ` +
        `${(err as Error).message}`,
    );
  }
}
