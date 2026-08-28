/**
 * THE inventory of what actually triggers each sync job.
 *
 * Why this file exists
 * --------------------
 * `SyncRegistry.register(name, runner, { cronExpression })` reads like a
 * schedule, but the registry NEVER schedules anything — it is an inventory and
 * a manual-run map. That made `cronExpression` documentation that nothing
 * enforced, and `GET /sync/jobs` computed a `nextRunAt` from it, so the API
 * confidently reported a next-run time for jobs with no trigger at all.
 *
 * Measured against prod when this file was written: 38 registered jobs, 22
 * Cloud Scheduler entries covering 17 of them, 17 more run only as phases of
 * the premarket Cloud Run job, and 4 that nothing triggers.
 *
 * A job's trigger is now declared here, next to its schedule, in one readable
 * list. `assertManifestCoversRegistry()` fails loudly when the two drift, so a
 * new job cannot quietly join the 4.
 *
 * Plain data on purpose: no Nest decorators, no DI. The live service does not
 * load SyncModule (APP_ROLE gating in app.module.ts), so nothing is registered
 * there — but the admin Monitor still has to describe every job. A shared
 * constant is readable from both roles; the registry is not.
 */

/** How a job actually gets run in production. */
export type JobTrigger =
  /** Its own Cloud Scheduler entry POSTs /sync/<name>/run. */
  | "scheduler"
  /** No entry of its own; runs as a phase of the premarket Cloud Run job. */
  | "premarket"
  /** Nothing triggers it. Registered and reachable by manual run only. */
  | "none";

export interface JobManifestEntry {
  /** Registry name — must match SyncRegistry.register()'s first argument. */
  name: string;
  trigger: JobTrigger;
  /**
   * The schedule that actually fires it, in Cloud Scheduler's own words, or
   * null when nothing does. For a job with two entries (an intraday cadence and
   * a post-close catch-up) both are listed — that pairing is deliberate and was
   * invisible before this file.
   */
  schedules: string[];
  /** Short human note — why this cadence, or why there is no trigger. */
  note?: string;
}

/**
 * Cloud Scheduler entries, transcribed from
 * `gcloud scheduler jobs list --location us-central1`.
 *
 * All times are America/New_York. The `9-16` windows are market hours and the
 * `18`/`21` ones are post-close catch-ups.
 */
const SCHEDULER: JobManifestEntry[] = [
  { name: "company-quotes", trigger: "scheduler", schedules: ["*/15 4-20 * * 1-5"], note: "whole-universe price refresh, pre-market through after-hours" },
  { name: "earnings-actuals", trigger: "scheduler", schedules: ["*/5 6-7,16-17 * * 1-5"], note: "tight cadence around the BMO and AMC reporting windows" },
  { name: "earnings", trigger: "scheduler", schedules: ["0 21 * * 1-5"] },
  { name: "edgar-8k", trigger: "scheduler", schedules: ["0 17,19,21 * * 1-5", "0 */2 * * 6,0"], note: "weekdays: a light top-up for the day's own reporters. Weekends: sweeps the whole quarter, when nothing else contends for the worker — guidance is immutable once filed, so the quarter fills once and later runs cost two queries" },
  { name: "fear-greed", trigger: "scheduler", schedules: ["*/15 9-16 * * 1-5", "15 18 * * 1-5"], note: "reads market-breadth output, so it trails it by 15m post-close" },
  { name: "intraday-bars", trigger: "scheduler", schedules: ["25 16 * * 1-5"] },
  { name: "macro-events", trigger: "scheduler", schedules: ["10 18 * * 1-5"] },
  { name: "market-breadth", trigger: "scheduler", schedules: ["0 9,11,13,15 * * 1-5", "30 18 * * 1-5"] },
  { name: "market-indices", trigger: "scheduler", schedules: ["*/15 9-16 * * 1-5", "5 18 * * 1-5"] },
  { name: "market-movers", trigger: "scheduler", schedules: ["*/15 9-16 * * 1-5", "0 18 * * 1-5"] },
  { name: "market-quotes", trigger: "scheduler", schedules: ["7 18 * * 1-5"], note: "the intraday */15 entry (sync-market-quotes-2m) is PAUSED — company-quotes covers that window" },
  { name: "news", trigger: "scheduler", schedules: ["*/10 * * * *"], note: "every 10 minutes, all week — news does not keep market hours" },
  { name: "options-chains", trigger: "scheduler", schedules: ["0 19 * * 1-5"] },
  { name: "recaps", trigger: "scheduler", schedules: ["45 18 * * 1-5"] },
  { name: "recap-blog", trigger: "scheduler", schedules: ["0 19 * * 1-5"], note: "reads the recaps snapshot, so it trails it by 15m; publishes a Draft blog post" },
  { name: "sectors", trigger: "scheduler", schedules: ["0 18 * * 1-5"] },
  { name: "ticker-universe", trigger: "scheduler", schedules: ["0 8 * * 1-5"] },
  { name: "premarket", trigger: "scheduler", schedules: ["0 8 * * 1-5"], note: "Cloud Run JOB premarket-job, not an HTTP POST — it orchestrates the phases below" },
];

/**
 * Run only as phases of the premarket Cloud Run job — see MARKET_WIDE /
 * PER_TICKER / FINAL in sync/premarket.job.ts. Each has a cronExpression in its
 * registration that nothing reads; the premarket schedule below is what
 * actually determines when it runs.
 */
const PREMARKET_PHASE = "0 8 * * 1-5";
const VIA_PREMARKET: string[] = [
  "market-indices", "sectors", "market-movers", "market-breadth", "fear-greed",
  "macro-events", "macro-regime", "earnings", "ipos", "edgar-ipo-pipeline",
  "news", "analyst-actions", "companies", "companies-financials-backfill",
  "stock-history", "edgar-8k", "technical-indicators", "rs-rating", "tech-rating",
  "financials", "fundamentals-growth", "corporate-actions", "recaps",
  "institutional-ownership", "dividends", "sec-13f", "sec-form4",
];

/**
 * Nothing triggers these. Kept deliberately (they are reachable by manual run),
 * but the Monitor labels them so the state is visible rather than implied by a
 * `nextRunAt` that will never arrive.
 *
 * auto-purge carries an @Cron decorator, which still does not fire: the worker
 * runs cpu-throttling=true with no minScale, so it gets no CPU between requests
 * — the same reason premarket had to become a Cloud Run job. The other three
 * have no scheduling mechanism at all.
 */
const NOT_TRIGGERED: JobManifestEntry[] = [
  { name: "auto-purge", trigger: "none", schedules: [], note: "@Cron 0 0 * * * cannot fire on a CPU-throttled, scale-to-zero worker" },
  { name: "monthly-news-cleanup", trigger: "none", schedules: [], note: "registered only — no scheduler entry and no cron decorator" },
  { name: "ticker-weekly-ai", trigger: "none", schedules: [], note: "registered only — no scheduler entry and no cron decorator" },
  { name: "ticker-monthly-ai", trigger: "none", schedules: [], note: "registered only — no scheduler entry and no cron decorator" },
];

const bySchedulerName = new Map(SCHEDULER.map((e) => [e.name, e]));

export const JOB_MANIFEST: JobManifestEntry[] = [
  ...SCHEDULER,
  // A job with its own entry keeps that entry even if premarket also runs it —
  // the scheduler cadence is the one that governs freshness.
  ...VIA_PREMARKET.filter((n) => !bySchedulerName.has(n)).map(
    (name): JobManifestEntry => ({
      name,
      trigger: "premarket",
      schedules: [PREMARKET_PHASE],
      note: "runs as a phase of the premarket job",
    }),
  ),
  ...NOT_TRIGGERED,
];

const byName = new Map(JOB_MANIFEST.map((e) => [e.name, e]));

export function jobManifest(name: string): JobManifestEntry | undefined {
  return byName.get(name);
}

/**
 * Fails when the registry and this manifest disagree, so adding a job forces a
 * decision about how it will be triggered instead of leaving it silently
 * un-run. Called at worker startup; logs rather than throws, because refusing
 * to boot would take the whole worker down over an inventory mismatch.
 */
export function manifestDrift(registeredNames: string[]): {
  missingFromManifest: string[];
  missingFromRegistry: string[];
} {
  const registered = new Set(registeredNames);
  return {
    missingFromManifest: registeredNames.filter((n) => !byName.has(n)).sort(),
    missingFromRegistry: [...byName.keys()].filter((n) => !registered.has(n)).sort(),
  };
}
