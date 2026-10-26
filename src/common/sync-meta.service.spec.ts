import { isJobStale, isJobStaleFor } from "./sync-meta.service";
import { manifestDrift } from "./job-manifest";

/**
 * Real production sync_meta (read-only snapshot, Mon 2026-10-26 16:17Z,
 * validation-output/trace_HIJKL). Each job is judged on its own cron and zone.
 */
describe("Sync staleness: two scheduled runs missed since the last success", () => {
  const fx = require("./fixtures/sync-meta-2026-10-26.json");
  const now = new Date("2026-10-26T16:17:00Z");
  const stale = (job: string) =>
    isJobStale(fx[job].lastSuccessAt, fx[job].cronExpression, fx[job].timeZone, now);

  it.each([
    "eod-recap", // Fri 16:15 ET success; next run Mon 16:15 ET
    "recap-blog", // Fri 19:00 ET success
    "market-quotes", // Fri 18:07 ET success
    "intraday-bars", // Fri 16:25 ET success
    "edgar-ipo-pipeline", // Sat success; Mon 08:00 ET is the first run since
    "company-quotes", // */5 4-20 weekdays: 16:00Z success, 16:17Z now
    "news", // */10: 15:50Z success — 16:00 and 16:10 passed, within the grace
  ])("%s is not stale (weekend / overnight gap, not a failure)", (job) => {
    expect(stale(job)).toBe(false);
  });

  it.each([
    "earnings", // 410 from Polygon financials since Oct 24
    "premarket", // last success Sep 3
    "sec-13f", // missed Oct 25 and Oct 26 01:00
    "sec-form4",
    "companies-financials-backfill",
  ])("%s is stale", (job) => {
    expect(stale(job)).toBe(true);
  });

  it("never succeeded: stale", () => {
    expect(isJobStale(null, "0 8 * * 1-5", "America/New_York", now)).toBe(true);
  });
});

describe("staleness is judged on the job's real trigger (job-manifest), not its registered cron", () => {
  it("stock-history runs in the weekday premarket job: Friday's success is not stale on Sunday", () => {
    // Registered cron "0 3 * * *" (daily) would flag it Sunday; the real trigger is premarket, 08:00 ET weekdays.
    const fri = "2026-10-23T12:30:08.494Z";
    expect(isJobStaleFor("stock-history", fri, "0 3 * * *", "America/New_York", new Date("2026-10-25T20:00:00Z"))).toBe(false);
    expect(isJobStaleFor("stock-history", fri, "0 3 * * *", "America/New_York", new Date("2026-10-27T13:00:00Z"))).toBe(true);
  });

  it("a job nothing triggers is never reported stale", () => {
    expect(isJobStaleFor("history-backfill", "2026-09-02T05:34:31.811Z", "0 0 30 2 *", "America/New_York", new Date("2026-10-26T16:17:00Z"))).toBe(false);
  });

  it("staleness-check and the strategy-lab / analyst-firm-stats jobs are declared, so the registry has no drift", () => {
    expect(manifestDrift(["staleness-check", "analyst-firm-stats", "strategy-lab-daily", "strategy-lab-intraday"]).missingFromManifest).toEqual([]);
  });
});
