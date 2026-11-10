import { CronTime } from "cron";
import { DEFAULT_JOB_TIME_ZONE, type JobManifestEntry } from "./job-manifest";

/**
 * Schedule arithmetic and health classification for the admin Jobs tab and for
 * the producer-freshness half of the screen/API status.
 *
 * Everything here is judged against the schedule the MANIFEST declares, which
 * is documentation of Cloud Scheduler rather than a read of it (see the header
 * of job-manifest.ts). So the vocabulary is deliberately modest: a job is
 * "late" only when it has plainly stopped, not when it is a tick behind.
 */

/** A job that has missed this many consecutive scheduled slots is "late"... */
export const LATE_AFTER_MISSED_SLOTS = 3;

/**
 * ...but never before its first missed slot is at least this overdue.
 *
 * The floor is what stops a fast job flickering. A 5-minute job with a
 * 30-minute lease (sync.controller.ts takes one and never releases it on the
 * inline path) really runs every 30-40 minutes; three missed 5-minute slots is
 * only 15 minutes, so without a floor it would read "late" for most of every
 * cycle. An hour clears that and is still quick to notice a dead cron.
 */
export const LATE_MIN_OVERDUE_MS = 60 * 60_000;

/** A slot only counts as missed once it is this far past due. */
const SLOT_GRACE_MS = 5 * 60_000;

/**
 * - `failing`   last recorded run ended in an error
 * - `never-run` nothing has ever recorded a run
 * - `manual`    has run, but nothing is scheduled to run it again
 * - `late`      scheduled, and has missed at least LATE_AFTER_MISSED_SLOTS runs
 * - `ok`        otherwise
 */
export type JobHealth = "ok" | "failing" | "late" | "never-run" | "manual";

export interface JobMetaLike {
  lastSyncedAt?: unknown;
  lastStatus?: unknown;
}

export interface JobAssessment {
  health: JobHealth;
  /** Zone the schedules are written in. */
  timeZone: string;
  /** Next declared fire time, or null when nothing is scheduled. */
  nextRunAt: string | null;
  /** When the job should next have run after its last recorded run (late only). */
  expectedBy: string | null;
  /** Consecutive scheduled slots since the last recorded run that have passed. */
  missedSlots: number;
}

export function jobTimeZone(entry: Pick<JobManifestEntry, "timeZone">): string {
  return entry.timeZone ?? DEFAULT_JOB_TIME_ZONE;
}

/**
 * The next `count` instants, strictly after `after`, at which any of
 * `schedules` fires — soonest first. An expression the cron library rejects is
 * skipped rather than thrown, so one bad entry cannot blank the whole tab
 * (job-manifest.spec.ts is what keeps the entries valid).
 */
export function nextSlots(
  schedules: string[],
  timeZone: string,
  after: Date,
  count: number,
): Date[] {
  const instants: number[] = [];
  for (const expression of schedules) {
    let time: CronTime;
    try {
      time = new CronTime(expression, timeZone);
    } catch {
      continue;
    }
    let cursor = after;
    for (let i = 0; i < count; i++) {
      const next = time.getNextDateFrom(cursor, timeZone).toJSDate();
      instants.push(next.getTime());
      cursor = next;
    }
  }
  return instants
    .sort((a, b) => a - b)
    .slice(0, count)
    .map((ms) => new Date(ms));
}

function parseIso(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function assessJob(
  entry: JobManifestEntry,
  meta: JobMetaLike | undefined,
  now: Date = new Date(),
): JobAssessment {
  const timeZone = jobTimeZone(entry);
  const scheduled = entry.trigger !== "none" && entry.schedules.length > 0;
  const nextRun = scheduled
    ? nextSlots(entry.schedules, timeZone, now, 1)[0]
    : undefined;
  const base = {
    timeZone,
    nextRunAt: nextRun ? nextRun.toISOString() : null,
    expectedBy: null as string | null,
    missedSlots: 0,
  };

  if (meta?.lastStatus === "error") return { ...base, health: "failing" };
  const last = parseIso(meta?.lastSyncedAt);
  if (last === null) return { ...base, health: "never-run" };
  if (!scheduled) return { ...base, health: "manual" };

  const slots = nextSlots(
    entry.schedules,
    timeZone,
    new Date(last),
    LATE_AFTER_MISSED_SLOTS,
  );
  const nowMs = now.getTime();
  const missedSlots = slots.filter((s) => s.getTime() + SLOT_GRACE_MS <= nowMs)
    .length;
  const first = slots[0];
  const late =
    missedSlots >= LATE_AFTER_MISSED_SLOTS &&
    first !== undefined &&
    nowMs - first.getTime() >= LATE_MIN_OVERDUE_MS;

  return {
    ...base,
    health: late ? "late" : "ok",
    expectedBy: late ? first.toISOString() : null,
    missedSlots,
  };
}
