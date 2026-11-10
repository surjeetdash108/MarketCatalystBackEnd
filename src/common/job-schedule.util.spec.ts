import type { JobManifestEntry } from "./job-manifest";
import {
  LATE_AFTER_MISSED_SLOTS,
  assessJob,
  jobTimeZone,
  nextSlots,
} from "./job-schedule.util";

// 2026-10-30 is a Friday and US daylight time runs until Sunday 1 Nov, so a
// New York wall clock is UTC-4 on this Friday and UTC-5 from Monday 2 Nov.
const NY = "America/New_York";
const at = (iso: string) => new Date(iso);
const iso = (d: Date | undefined) => d?.toISOString();

const job = (over: Partial<JobManifestEntry>): JobManifestEntry => ({
  name: "j",
  trigger: "scheduler",
  schedules: ["*/15 9-16 * * 1-5"],
  ...over,
});

describe("nextSlots", () => {
  it("lists the next slots strictly after the given instant", () => {
    const out = nextSlots(["*/15 9-16 * * 1-5"], NY, at("2026-10-30T13:40:00Z"), 3);
    expect(out.map(iso)).toEqual([
      "2026-10-30T13:45:00.000Z",
      "2026-10-30T14:00:00.000Z",
      "2026-10-30T14:15:00.000Z",
    ]);
    // Standing exactly on a slot yields the NEXT one, not that slot again.
    const onSlot = nextSlots(["*/15 9-16 * * 1-5"], NY, at("2026-10-30T13:45:00Z"), 1);
    expect(iso(onSlot[0])).toBe("2026-10-30T14:00:00.000Z");
  });

  it("merges a job's schedules soonest first and carries over the weekend and DST", () => {
    const out = nextSlots(["0 9 * * 1-5", "0 18 * * 1-5"], NY, at("2026-10-30T14:00:00Z"), 3);
    expect(out.map(iso)).toEqual([
      "2026-10-30T22:00:00.000Z", // Fri 18:00 EDT
      "2026-11-02T14:00:00.000Z", // Mon 09:00 EST
      "2026-11-02T23:00:00.000Z", // Mon 18:00 EST
    ]);
  });

  it("reads the cron text in the zone it is given", () => {
    const from = at("2026-10-30T00:00:00Z");
    expect(iso(nextSlots(["0 8 * * 1-5"], NY, from, 1)[0])).toBe("2026-10-30T12:00:00.000Z");
    expect(iso(nextSlots(["0 8 * * 1-5"], "America/Chicago", from, 1)[0])).toBe(
      "2026-10-30T13:00:00.000Z",
    );
  });

  it("skips an expression the cron library rejects instead of throwing", () => {
    const out = nextSlots(["definitely not cron", "0 9 * * *"], NY, at("2026-10-30T00:00:00Z"), 1);
    expect(out).toHaveLength(1);
  });
});

describe("assessJob", () => {
  const now = at("2026-10-30T14:07:00Z"); // Fri 10:07 EDT, market hours

  it("is failing whenever the last recorded run ended in an error", () => {
    const a = assessJob(job({}), { lastSyncedAt: "2026-10-30T14:00:00Z", lastStatus: "error" }, now);
    expect(a.health).toBe("failing");
  });

  it("is never-run when nothing has recorded a run, and still reports the next slot", () => {
    const a = assessJob(job({}), undefined, now);
    expect(a.health).toBe("never-run");
    expect(a.nextRunAt).toBe("2026-10-30T14:15:00.000Z");
    expect(assessJob(job({}), { lastSyncedAt: "not a date" }, now).health).toBe("never-run");
  });

  it("is manual when it has run but nothing schedules it", () => {
    const entry = job({ trigger: "none", schedules: [] });
    const a = assessJob(entry, { lastSyncedAt: "2026-10-01T00:00:00Z", lastStatus: "ok" }, now);
    expect(a.health).toBe("manual");
    expect(a.nextRunAt).toBeNull();
  });

  it("is ok when it ran recently", () => {
    const a = assessJob(job({}), { lastSyncedAt: "2026-10-30T14:00:00Z", lastStatus: "ok" }, now);
    expect(a.health).toBe("ok");
    expect(a.expectedBy).toBeNull();
  });

  it("is late once it has missed three slots and the first is an hour overdue", () => {
    // Last ran 11:00 EDT; slots 11:15, 11:30, 11:45 are all long past by 14:07Z.
    const lastRan = "2026-10-30T11:00:00Z"; // 07:00 EDT
    const a = assessJob(job({}), { lastSyncedAt: lastRan, lastStatus: "ok" }, now);
    expect(a.health).toBe("late");
    expect(a.missedSlots).toBe(LATE_AFTER_MISSED_SLOTS);
    // 07:00 EDT is outside the 9-16 window, so the first slot is 09:00 EDT = 13:00Z.
    expect(a.expectedBy).toBe("2026-10-30T13:00:00.000Z");
  });

  it("does not flicker for a fast job that is merely running at the lease's cadence", () => {
    const fast = job({ schedules: ["*/5 * * * *"] });
    const t = at("2026-10-30T14:00:00Z");
    // 40 minutes since the last run: 3+ slots missed, but the first is only 35
    // minutes overdue — the 30-minute-lease cadence, not a dead cron.
    expect(assessJob(fast, { lastSyncedAt: "2026-10-30T13:20:00Z", lastStatus: "ok" }, t).health).toBe("ok");
    expect(assessJob(fast, { lastSyncedAt: "2026-10-30T12:30:00Z", lastStatus: "ok" }, t).health).toBe("late");
  });

  it("is not late over a weekend a weekday job is not supposed to run in", () => {
    const quotes = job({ schedules: ["*/15 4-20 * * 1-5"] });
    const saturdayNoon = at("2026-10-31T16:00:00Z");
    const a = assessJob(quotes, { lastSyncedAt: "2026-10-31T00:45:00Z", lastStatus: "ok" }, saturdayNoon);
    expect(a.health).toBe("ok");
    expect(a.nextRunAt).toBe("2026-11-02T09:00:00.000Z"); // Mon 04:00 EST
  });

  it("counts a daily job late only after three missed days", () => {
    const daily = job({ schedules: ["0 8 * * 1-5"] });
    const lastRan = "2026-10-26T12:00:00Z"; // Mon 08:00 EDT
    const status = "ok";
    // Wed 08:05: two slots (Tue, Wed) have passed.
    expect(assessJob(daily, { lastSyncedAt: lastRan, lastStatus: status }, at("2026-10-28T12:05:00Z")).health).toBe("ok");
    // Thu 08:10: the third has passed too, and the first is long overdue.
    expect(assessJob(daily, { lastSyncedAt: lastRan, lastStatus: status }, at("2026-10-29T12:10:00Z")).health).toBe("late");
  });

  it("uses the entry's own time zone", () => {
    const chicago = job({ schedules: ["0 8 * * 1-5"], timeZone: "America/Chicago" });
    expect(jobTimeZone(chicago)).toBe("America/Chicago");
    expect(assessJob(chicago, undefined, at("2026-10-30T00:00:00Z")).nextRunAt).toBe(
      "2026-10-30T13:00:00.000Z",
    );
    expect(jobTimeZone(job({}))).toBe(NY);
  });
});
