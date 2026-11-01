import { JOB_MANIFEST } from "../common/job-manifest";
import {
  FINAL,
  MARKET_WIDE,
  PER_TICKER,
  PREMARKET_JOBS,
} from "../common/premarket-phases";
import {
  assessActivity,
  jobFeeds,
  jobRole,
  jobWrites,
  premarketProgress,
} from "./job-activity";
import type { AdminJobRun } from "./job-runs";

const T0 = Date.parse("2026-10-30T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const run = (over: Partial<AdminJobRun> = {}): AdminJobRun => ({
  id: "run00000000000000001",
  job: "news",
  status: "running",
  transport: "cloud-run-job",
  requestedBy: "admin@marketcatalyst.ai",
  requestedAt: iso(T0),
  startedAt: iso(T0),
  finishedAt: null,
  executionName: null,
  attempt: null,
  clearedStaleLock: false,
  summary: null,
  error: null,
  ...over,
});

describe("premarket phases", () => {
  it("include every job the manifest says runs inside premarket, and only manifest jobs", () => {
    const names = new Set(JOB_MANIFEST.map((e) => e.name));
    for (const job of PREMARKET_JOBS) expect(names.has(job)).toBe(true);
    const viaPremarket = JOB_MANIFEST.filter((e) => e.trigger === "premarket").map((e) => e.name);
    // Some phase jobs also have a scheduler entry of their own (so the manifest
    // calls them "scheduler"), but none that the manifest ties to premarket may
    // be missing from the phase lists.
    for (const job of viaPremarket) expect(PREMARKET_JOBS).toContain(job);
  });

  it("run each job once", () => {
    expect(new Set(PREMARKET_JOBS).size).toBe(PREMARKET_JOBS.length);
    expect(PREMARKET_JOBS).toEqual([...MARKET_WIDE, ...PER_TICKER, ...FINAL]);
  });
});

describe("jobRole", () => {
  it("places a phase job between its neighbours", () => {
    const role = jobRole("fear-greed");
    expect(role.partOf).toBe("premarket");
    expect(role.step).toMatchObject({
      group: "Market-wide",
      after: "market-breadth",
      before: "macro-events",
      of: PREMARKET_JOBS.length,
    });
  });

  it("has no previous step for the first job and no next for the last", () => {
    expect(jobRole(PREMARKET_JOBS[0]).step?.after).toBeNull();
    expect(jobRole(PREMARKET_JOBS[PREMARKET_JOBS.length - 1]).step?.before).toBeNull();
  });

  it("lists the bundle's steps, warm step first, on premarket itself", () => {
    const role = jobRole("premarket");
    expect(role.partOf).toBeNull();
    expect(role.steps?.[0]).toMatchObject({ name: "warm", group: "Warm" });
    expect(role.steps?.length).toBe(PREMARKET_JOBS.length + 1);
    expect(role.steps?.[role.steps.length - 1].name).toBe("recaps");
  });

  it("says nothing about a job that is not part of the bundle", () => {
    expect(jobRole("volume-leaders")).toEqual({ partOf: null, step: null, steps: null });
  });
});

describe("jobFeeds / jobWrites", () => {
  it("finds the APIs a job produces and the screens that call them", () => {
    const feeds = jobFeeds("earnings-actuals");
    expect(feeds.length).toBeGreaterThan(0);
    const wire = feeds.find((f) => f.api === "GET /live/earnings-wire");
    expect(wire?.relation).toBe("feeds");
    expect(wire?.screens.map((s) => s.id)).toContain("commentary");
    expect(wire?.screens[0]).toHaveProperty("label");
  });

  it("is empty for a job nothing in the catalogue reads", () => {
    expect(jobFeeds("no-such-job")).toEqual([]);
  });

  it("merges registered collections with the stores of the APIs it feeds, once each", () => {
    const feeds = jobFeeds("earnings-actuals");
    const writes = jobWrites(feeds, { collections: ["earnings_events", "extra"] });
    expect(writes).toContain("earnings_events");
    expect(writes).toContain("extra");
    expect(writes.filter((w) => w === "earnings_events")).toHaveLength(1);
  });

  it("ignores a malformed collections value", () => {
    expect(jobWrites([], { collections: "nope" })).toEqual([]);
    expect(jobWrites([], undefined)).toEqual([]);
  });
});

describe("premarketProgress", () => {
  const meta = (finished: Record<string, [number, string]>) =>
    new Map(
      Object.entries(finished).map(([job, [at, status]]) => [
        job,
        { lastSyncedAt: iso(at), lastStatus: status },
      ]),
    );

  it("is on the warm step until any step has finished", () => {
    const p = premarketProgress(T0, meta({ news: [T0 - 60_000, "ok"] })); // before this run
    expect(p.current).toBe("warm");
    expect(p.steps[0].state).toBe("running");
    expect(p.steps.filter((s) => s.state === "done")).toHaveLength(0);
  });

  it("marks steps finished since the start, and the first unfinished one as current", () => {
    const p = premarketProgress(
      T0,
      meta({
        "market-indices": [T0 + 60_000, "ok"],
        sectors: [T0 + 120_000, "ok"],
      }),
    );
    expect(p.steps[0].state).toBe("done"); // warm is over once a step has finished
    expect(p.steps.find((s) => s.name === "sectors")?.state).toBe("done");
    expect(p.current).toBe("market-movers");
    expect(p.steps.find((s) => s.name === "market-movers")?.state).toBe("running");
    expect(p.steps.find((s) => s.name === "fear-greed")?.state).toBe("waiting");
  });

  it("counts a step that failed as passed, and says it failed", () => {
    const p = premarketProgress(
      T0,
      meta({ "market-indices": [T0 + 60_000, "error"], sectors: [T0 + 90_000, "ok"] }),
    );
    expect(p.steps.find((s) => s.name === "market-indices")?.state).toBe("failed");
    expect(p.current).toBe("market-movers");
  });

  it("flags the steps that also run on their own schedule, whose 'done' may belong to another run", () => {
    const p = premarketProgress(T0, meta({ news: [T0 + 1000, "ok"], beta: [T0 + 2000, "ok"] }));
    expect(p.steps.find((s) => s.name === "news")?.ownSchedule).toBe(true);
    expect(p.steps.find((s) => s.name === "beta")?.ownSchedule).toBe(false);
    expect(p.steps[0].ownSchedule).toBe(false);
  });

  it("has no current step once every step has finished", () => {
    const all = Object.fromEntries(PREMARKET_JOBS.map((j) => [j, [T0 + 1000, "ok"]]));
    const p = premarketProgress(T0, meta(all as Record<string, [number, string]>));
    expect(p.current).toBeNull();
    expect(p.steps.every((s) => s.state === "done")).toBe(true);
  });
});

describe("assessActivity", () => {
  const base = { metaByJob: new Map(), now: T0 + 5 * 60_000 };

  it("is null when nothing is running", () => {
    expect(
      assessActivity({ name: "news", lock: undefined, leaseStale: false, adminRun: undefined, ...base }),
    ).toBeNull();
    expect(
      assessActivity({
        name: "news",
        lock: undefined,
        leaseStale: false,
        adminRun: run({ status: "succeeded" }),
        ...base,
      }),
    ).toBeNull();
  });

  it("is null for a lease whose run has already finished", () => {
    const lock = { owner: "scheduler-run", acquiredAt: T0, expiresAt: T0 + 30 * 60_000 };
    expect(
      assessActivity({ name: "news", lock, leaseStale: true, adminRun: undefined, ...base }),
    ).toBeNull();
  });

  it("reports a live lease as running, with how long and until when", () => {
    const lock = { owner: "scheduler-run", acquiredAt: T0, expiresAt: T0 + 30 * 60_000 };
    const a = assessActivity({ name: "news", lock, leaseStale: false, adminRun: undefined, ...base })!;
    expect(a.state).toBe("running");
    expect(a.elapsedMs).toBe(5 * 60_000);
    expect(a.startedAt).toBe(iso(T0));
    expect(a.leaseUntil).toBe(iso(T0 + 30 * 60_000));
    expect(a.startedBy).toEqual({ kind: "lease", owner: "scheduler-run" });
    expect(a.steps).toBeNull();
    expect(a.note).toMatch(/reports no progress/);
  });

  it("credits an in-flight manual run to the admin who asked", () => {
    const lock = { owner: "job-entry-1", acquiredAt: T0, expiresAt: T0 + 3_600_000 };
    const a = assessActivity({ name: "news", lock, leaseStale: false, adminRun: run(), ...base })!;
    expect(a.startedBy).toEqual({ kind: "admin", by: "admin@marketcatalyst.ai" });
    expect(a.runId).toBe("run00000000000000001");
  });

  it("calls a manual run with no lease yet 'starting'", () => {
    const a = assessActivity({
      name: "news",
      lock: undefined,
      leaseStale: false,
      adminRun: run({ status: "queued", startedAt: null }),
      ...base,
    })!;
    expect(a.state).toBe("starting");
    expect(a.startedAt).toBeNull();
    expect(a.elapsedMs).toBeNull();
    expect(a.leaseUntil).toBeNull();
    expect(a.note).toMatch(/not taken its lease/);
  });

  it("adds step progress for a running premarket, with the caveat", () => {
    const lock = { owner: "job-entry-1", acquiredAt: T0, expiresAt: T0 + 3_600_000 };
    const metaByJob = new Map([["market-indices", { lastSyncedAt: iso(T0 + 60_000), lastStatus: "ok" }]]);
    const a = assessActivity({
      name: "premarket",
      lock,
      leaseStale: false,
      adminRun: undefined,
      metaByJob,
      now: T0 + 5 * 60_000,
    })!;
    expect(a.steps?.length).toBe(PREMARKET_JOBS.length + 1);
    expect(a.current).toBe("sectors");
    expect(a.note).toMatch(/does not report progress/);
  });
});
