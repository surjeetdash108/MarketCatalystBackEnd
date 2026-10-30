import { CronTime } from "cron";
import { JOB_MANIFEST, jobManifest, manifestDrift } from "./job-manifest";

describe("JOB_MANIFEST", () => {
  it("names every job once", () => {
    const names = JOB_MANIFEST.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("gives every triggered job a schedule and an untriggered one none", () => {
    for (const e of JOB_MANIFEST) {
      if (e.trigger === "none") expect({ name: e.name, schedules: e.schedules }).toEqual({ name: e.name, schedules: [] });
      else expect({ name: e.name, n: e.schedules.length > 0 }).toEqual({ name: e.name, n: true });
    }
  });

  it("holds only cron expressions and time zones the cron library accepts", () => {
    for (const e of JOB_MANIFEST) {
      for (const expression of e.schedules) {
        expect(() => new CronTime(expression, e.timeZone ?? "America/New_York")).not.toThrow();
      }
    }
  });

  it("describes risk with a level and a reason", () => {
    const risky = JOB_MANIFEST.filter((e) => e.risk);
    expect(risky.length).toBeGreaterThan(0);
    for (const e of risky) {
      expect(["caution", "destructive"]).toContain(e.risk.level);
      expect(e.risk.note.length).toBeGreaterThan(20);
    }
  });

  it("marks exactly the jobs that delete data as destructive", () => {
    // A change to this set means a job started or stopped deleting. That should
    // be a decision someone made, not something that slipped through.
    const destructive = JOB_MANIFEST.filter((e) => e.risk?.level === "destructive").map((e) => e.name);
    expect(destructive.sort()).toEqual(["auto-purge", "monthly-news-cleanup"]);
  });

  it("carries the jobs the manifest used to be missing", () => {
    expect(jobManifest("analyst-firm-stats")).toMatchObject({ trigger: "premarket", schedules: ["0 8 * * 1-5"] });
    expect(jobManifest("strategy-lab-daily")).toMatchObject({ trigger: "scheduler", schedules: ["30 17 * * 1-5"] });
    expect(jobManifest("strategy-lab-intraday")).toMatchObject({ trigger: "scheduler", schedules: ["*/5 9-16 * * 1-5"] });
  });

  it("writes the two Central-time schedules in Central time", () => {
    expect(jobManifest("analyst-actions")?.timeZone).toBe("America/Chicago");
    expect(jobManifest("premarket-post")?.timeZone).toBe("America/Chicago");
    expect(jobManifest("news")?.timeZone).toBeUndefined();
  });
});

describe("manifestDrift", () => {
  it("reports names on one side only", () => {
    const names = JOB_MANIFEST.map((e) => e.name);
    expect(manifestDrift(names)).toEqual({ missingFromManifest: [], missingFromRegistry: [] });
    const drift = manifestDrift([...names.slice(1), "brand-new-job"]);
    expect(drift.missingFromManifest).toEqual(["brand-new-job"]);
    expect(drift.missingFromRegistry).toEqual([names[0]]);
  });
});
