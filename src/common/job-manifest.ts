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
 * list. `manifestDrift()` reports when the registry and this list disagree (it
 * is only LOGGED at worker start-up) and job-manifest.spec.ts fails the build on
 * it, so a new job cannot quietly join the 4. The admin Jobs tab lists, and can
 * run, exactly the jobs named here — a job missing from this file is invisible
 * to it.
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
  /**
   * IANA zone the `schedules` are written in. Absent means
   * DEFAULT_JOB_TIME_ZONE; see TIME_ZONE_OVERRIDES for the exceptions.
   */
  timeZone?: string;
  /**
   * Set when running the job by hand deserves more than a plain confirmation —
   * it deletes data, or publishes something readers can see. The admin Jobs tab
   * shows the note in the confirmation dialog; "destructive" also makes the
   * admin type the job name before it will run.
   */
  risk?: JobRisk;
}

export interface JobRisk {
  level: "caution" | "destructive";
  note: string;
}

/** The zone every schedule below is written in unless overridden. */
export const DEFAULT_JOB_TIME_ZONE = "America/New_York";

/**
 * Cloud Scheduler entries, transcribed from
 * `gcloud scheduler jobs list --location us-central1`.
 *
 * All times are America/New_York unless TIME_ZONE_OVERRIDES says otherwise. The
 * `9-16` windows are market hours and the `18`/`21` ones are post-close
 * catch-ups.
 */
const SCHEDULER: JobManifestEntry[] = [
  { name: "analyst-actions", trigger: "scheduler", schedules: ["0 8,12,16 * * 1-5"], note: "refreshes 3x daily: 8 AM CST (9 AM ET), 12 PM CST (1 PM ET), and 4 PM CST (5 PM ET)" },
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
  { name: "etf-holdings", trigger: "scheduler", schedules: ["0 19 * * 1-5"], note: "daily holdings snapshot for 16 popular ETFs after market close" },
  { name: "etf-market", trigger: "scheduler", schedules: ["0 0 * * 0"], note: "weekly full ETF universe sync: rotates current week to previous week, writes all discovered funds across 10 categories" },
  { name: "eod-recap", trigger: "scheduler", schedules: ["15 16 * * 1-5"], note: "EOD Recap blog post: feeds 16 ETFs + indices/commodities/crypto into Claude skill and publishes to blog 15 min after market close at 4:15 PM ET (3:15 PM CT)" },
  { name: "premarket-post", trigger: "scheduler", schedules: ["35 7 * * 1-5"], note: "Pre-Market Intelligence blog post: 7:35 AM CT (8:35 AM ET) 5 min after 7:30 AM CT macro prints; publishes movers, earnings, calendar, analyst calls, and what could happen today to blog" },
  { name: "d03-premarket-movers", trigger: "scheduler", schedules: ["45 8 * * 1-5"], note: "D03: Stocks Moving Premarket at 8:45 AM ET (cutoff 8:30 AM ET); top premarket movers 3%+ with catalysts, BMO earnings, economic calendar" },
  { name: "d04-analyst-calls", trigger: "scheduler", schedules: ["20 9 * * 1-5"], note: "D04: Analyst Calls daily roundup at 9:20 AM ET (cutoff 9:00 AM ET); upgrades, downgrades, price target math on notable names" },
  { name: "d06-why-it-moved", trigger: "scheduler", schedules: ["30 11 * * 1-5"], note: "D06: Mid-Morning Movers by Market Cap at 11:30 AM ET (cutoff 11:20 AM ET, fetch 11:25 AM ET); top 5 gainers & losers across Small/Mid/Large/Mega caps with AI summary" },
  { name: "sectors", trigger: "scheduler", schedules: ["0 18 * * 1-5"] },
  { name: "ticker-universe", trigger: "scheduler", schedules: ["0 8 * * 1-5"] },
  { name: "sec-form4", trigger: "scheduler", schedules: ["0 8 * * 6"], note: "moved off the weekday premarket path — insider filings tolerate a weekend cadence" },
  { name: "sec-13f", trigger: "scheduler", schedules: ["0 9 * * 6"], note: "13-F is a QUARTERLY filing; a weekday fetch re-read unchanged data ahead of the market-hours jobs" },
  { name: "institutional-ownership", trigger: "scheduler", schedules: ["0 10 * * *"], note: "fires daily but only WORKS inside the 13-F filing window (quarter end to deadline+15) or on Saturdays — filings arrive daily across that window and essentially never outside it. A skipped day makes no vendor call" },
  { name: "edgar-ipo-pipeline", trigger: "scheduler", schedules: ["0 11 * * 6"], note: "S-1/424B registrations move over weeks — a weekday fetch bought nothing" },
  { name: "companies-financials-backfill", trigger: "scheduler", schedules: ["0 12 * * 6"], note: "a cursor backfill with no deadline of its own" },
  { name: "market-glance-weekly", trigger: "scheduler", schedules: ["0 12 * * 5"], note: "Fridays 12:00 ET: builds and stores the current week's 'Week at a glance' digest (Live Feed > Weekly Summary) ahead of any viewer. Cloud Scheduler entry sync-market-glance-weekly (deploy/create-glance-weekly-scheduler.sh)" },
  { name: "volume-leaders", trigger: "scheduler", schedules: ["30 20 * * 1-5"], note: "ranks the whole US market by relative volume from ONE grouped-daily call; 20:30 ET, after the after-hours session closes at 20:00, so the day's volume is complete" },
  { name: "strategy-lab-daily", trigger: "scheduler", schedules: ["30 17 * * 1-5"], note: "Strategy Lab: after the close, appends the session to every stock's bar pack (one FMP bulk EOD call) and precomputes the daily library strategies. The entry sync-strategy-lab-daily is created only by deploy/create-scheduler-jobs.sh, which DEPLOY.md marks stale — confirm it is live with gcloud scheduler jobs list" },
  { name: "strategy-lab-intraday", trigger: "scheduler", schedules: ["*/5 9-16 * * 1-5"], note: "Strategy Lab: every 5 minutes in-session, refreshes the 5-minute bar packs and reruns the intraday library strategies. The entry sync-strategy-lab-intraday is created only by deploy/create-scheduler-jobs.sh, which DEPLOY.md marks stale — confirm it is live with gcloud scheduler jobs list" },
  { name: "premarket", trigger: "scheduler", schedules: ["0 8 * * 1-5"], note: "Cloud Run JOB premarket-job, not an HTTP POST — it orchestrates the phases below" },
  { name: "staleness-check", trigger: "scheduler", schedules: ["0 * * * *"], note: "hourly sweep: logs an ERROR for every job whose last success is older than two of its scheduled runs (a job that stops running never records itself)" },
];

/**
 * Schedules that are NOT written in America/New_York. The cron text is the
 * same shape either way, so without this the next-run time shown for these two
 * would be off by an hour.
 */
const TIME_ZONE_OVERRIDES: Record<string, string> = {
  // create-analyst-close-scheduler.sh creates the entry in America/Chicago:
  // 08:00 / 12:00 / 16:00 CT = 09:00 / 13:00 / 17:00 ET.
  "analyst-actions": "America/Chicago",
  // Registered as America/Chicago and documented as 7:35 AM CT. The deployed
  // entry's zone is not recorded in the repo.
  "premarket-post": "America/Chicago",
};

/**
 * Jobs where "run now" has a consequence beyond refreshing a cache. Every claim
 * below is read off the job's own code.
 */
const RISKS: Record<string, JobRisk> = {
  "auto-purge": {
    level: "destructive",
    note: "Deletes stale documents from the ephemeral collections (market_movers, options_chains): everything older than the latest write minus 12 hours. AUTO_PURGE_DRY_RUN=true makes it a preview.",
  },
  "monthly-news-cleanup": {
    level: "destructive",
    note: "Deletes documents from the news collection. It only acts on the last Friday of the month and only after the month's analysis receipt verifies; any other day it does nothing.",
  },
  "eod-recap": {
    level: "caution",
    note: "Writes the End-of-Day recap with an LLM and publishes it to the PUBLIC blog immediately. It skips weekends, market holidays and a day that already has a recap.",
  },
  "premarket-post": {
    level: "caution",
    note: "Writes the Pre-Market Intelligence post with an LLM and publishes it to the PUBLIC blog immediately. It does nothing unless ENABLE_PREMARKET_POST=true, and skips weekends, holidays and a day that already has a post.",
  },
  "recap-blog": {
    level: "caution",
    note: "Calls an LLM and saves a Draft recap post (never published automatically). It skips a day that already has one.",
  },
  "history-backfill": {
    level: "caution",
    note: "A 30-45 minute backfill. Run it after the close: its grouped-daily calls return a PARTIAL bar while the market is open.",
  },
  premarket: {
    level: "caution",
    note: "The whole premarket bundle (cache warm, market-wide jobs, per-ticker jobs, recaps) — roughly 18 minutes of vendor calls and Firestore writes.",
  },
};

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
  "financials", "fundamentals-growth", "corporate-actions", "beta", "recaps",
  "institutional-ownership", "dividends", "sec-13f", "sec-form4",
  // Phase 3 of premarket.job.ts, after beta; it was missing from this list.
  "analyst-firm-stats",
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
  { name: "recaps-nasdaq-backfill", trigger: "none", schedules: [], note: "one-off repair of recaps since 2026-08-13 (QQQ shown as Nasdaq) — manual run only" },
  { name: "history-backfill", trigger: "none", schedules: [], note: "one-off. Cloud Run JOB history-backfill-job (SYNC_JOB=history-backfill), run by hand after the close — a 30-45 min run cannot go over HTTP, and its grouped-daily calls return a PARTIAL bar during market hours" },
];

const bySchedulerName = new Map(SCHEDULER.map((e) => [e.name, e]));

const BASE_MANIFEST: JobManifestEntry[] = [
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

export const JOB_MANIFEST: JobManifestEntry[] = BASE_MANIFEST.map((entry) => ({
  ...entry,
  ...(TIME_ZONE_OVERRIDES[entry.name]
    ? { timeZone: TIME_ZONE_OVERRIDES[entry.name] }
    : {}),
  ...(RISKS[entry.name] ? { risk: RISKS[entry.name] } : {}),
}));

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
