import { isJobStale } from "./sync-meta.service";

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
