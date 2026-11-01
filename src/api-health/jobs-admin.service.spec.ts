import { HttpException } from "@nestjs/common";
import { FakeFirestore } from "../../test/support/fake-firestore";
import { MAX_RUNS_IN_FLIGHT, JobsAdminService, isLeaseStale } from "./jobs-admin.service";
import { ADMIN_JOB_RUNS_COLLECTION as RUNS, RUN_LOST_AFTER_MS } from "./job-runs";

const NOW = new Date("2026-10-30T14:07:00.000Z"); // Fri 10:07 EDT
const ADMIN = "admin@marketcatalyst.ai";

interface Rig {
  fs: FakeFirestore;
  svc: JobsAdminService;
  meta: Record<string, Record<string, unknown>>;
  fetchMock: jest.SpyInstance;
}

function rig(opts: { env?: Record<string, string>; registered?: string[]; metaDown?: boolean } = {}): Rig {
  const fs = new FakeFirestore();
  const meta: Record<string, Record<string, unknown>> = {};
  const registered = new Set(opts.registered ?? []);
  const env: Record<string, string> = {
    FIREBASE_PROJECT_ID: "market-catalyst-502415",
    JOB_RUNNER_JOB: "premarket-job",
    ...opts.env,
  };
  const firebase = {
    firestore: fs,
    getAccessToken: async () => "tok",
    describeIdentity: () => "the live service account",
  };
  const syncMeta = {
    statusAll: async () => {
      if (opts.metaDown) throw new Error("sync_meta unavailable");
      return Object.entries(meta).map(([job, m]) => ({ job, ...m }));
    },
    status: async (job: string) => ({ job, ...(meta[job] ?? { lastSyncedAt: null }) }),
  };
  const registry = {
    get: (name: string) => (registered.has(name) ? async () => ({ ok: true }) : undefined),
    names: () => [...registered],
  };
  const config = { get: (k: string) => env[k] };
  const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ metadata: { name: "projects/p/locations/us-central1/jobs/premarket-job/executions/premarket-job-abc12" } }),
      }) as Response,
  );
  const svc = new JobsAdminService(firebase as never, syncMeta as never, registry as never, config as never);
  return { fs, svc, meta, fetchMock };
}

afterEach(() => jest.restoreAllMocks());

async function refusal(promise: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const err = (await promise.catch((e) => e)) as HttpException;
  expect(err).toBeInstanceOf(HttpException);
  return { status: err.getStatus(), body: err.getResponse() as Record<string, unknown> };
}

const lease = (over: Record<string, unknown> = {}) => ({
  owner: "scheduler-1",
  acquiredAt: NOW.getTime() - 10 * 60_000,
  expiresAt: NOW.getTime() + 20 * 60_000,
  ...over,
});

describe("isLeaseStale", () => {
  it("is stale when the job recorded a run after the lease was taken", () => {
    const lock = { acquiredAt: Date.parse("2026-10-30T14:00:00Z") };
    expect(isLeaseStale(lock, { lastSyncedAt: "2026-10-30T14:02:00Z" })).toBe(true);
    expect(isLeaseStale(lock, { lastSyncedAt: "2026-10-30T14:00:00Z" })).toBe(true);
  });
  it("is not stale while the run that took it has yet to record anything", () => {
    const lock = { acquiredAt: Date.parse("2026-10-30T14:00:00Z") };
    expect(isLeaseStale(lock, { lastSyncedAt: "2026-10-30T13:45:00Z" })).toBe(false);
    expect(isLeaseStale(lock, { lastSyncedAt: null })).toBe(false);
    expect(isLeaseStale(lock, undefined)).toBe(false);
  });
});

describe("JobsAdminService.requestRun — what it refuses, before anything starts", () => {
  it("only runs jobs in the manifest", async () => {
    const { svc, fs, fetchMock } = rig();
    const r = await refusal(svc.requestRun("rm-rf", ADMIN, {}, NOW));
    expect(r).toMatchObject({ status: 404, body: { code: "UNKNOWN_JOB" } });
    expect(fs.ids(RUNS)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes a destructive job need its own name typed", async () => {
    const { svc, fs, fetchMock } = rig();
    for (const confirm of [undefined, "", "yes", "AUTO-PURGE", "auto-purge "]) {
      const r = await refusal(svc.requestRun("auto-purge", ADMIN, { confirm }, NOW));
      expect(r).toMatchObject({ status: 400, body: { code: "CONFIRM_REQUIRED" } });
    }
    expect(fs.ids(RUNS)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    const ok = await svc.requestRun("auto-purge", ADMIN, { confirm: "auto-purge" }, NOW);
    expect(ok.run.job).toBe("auto-purge");
  });

  it("does not ask for a typed confirmation of a job that does not delete", async () => {
    const { svc } = rig();
    await expect(svc.requestRun("news", ADMIN, {}, NOW)).resolves.toBeDefined();
  });

  it("says so when no way to run it is set up, and writes nothing", async () => {
    const { svc, fs, fetchMock } = rig({ env: { JOB_RUNNER_JOB: "" } });
    const r = await refusal(svc.requestRun("news", ADMIN, {}, NOW));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("RUNNER_NOT_CONFIGURED");
    expect(String(r.body.message)).toContain("JOB_RUNNER_JOB");
    expect(fs.ids(RUNS)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a misconfigured runner as such rather than building a bad URL", async () => {
    const { svc, fetchMock } = rig({ env: { JOB_RUNNER_JOB: "../../x" } });
    const r = await refusal(svc.requestRun("news", ADMIN, {}, NOW));
    expect(r.body.code).toBe("RUNNER_MISCONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses while the job is running, naming when its lease ends", async () => {
    const { svc, fs, fetchMock, meta } = rig();
    fs.seed("job_locks", "news", lease());
    meta.news = { lastSyncedAt: new Date(NOW.getTime() - 3 * 3600_000).toISOString() }; // last record predates the lease
    const r = await refusal(svc.requestRun("news", ADMIN, {}, NOW));
    expect(r).toMatchObject({ status: 409, body: { code: "JOB_LOCKED" } });
    expect(JSON.stringify(r.body)).toContain(new Date(NOW.getTime() + 20 * 60_000).toISOString());
    expect(fs.ids(RUNS)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let clearStaleLock override a lease that is NOT stale", async () => {
    const { svc, fs, meta } = rig();
    fs.seed("job_locks", "news", lease());
    meta.news = { lastSyncedAt: new Date(NOW.getTime() - 3 * 3600_000).toISOString() };
    const r = await refusal(svc.requestRun("news", ADMIN, { clearStaleLock: true }, NOW));
    expect(r.body.code).toBe("JOB_LOCKED");
    expect(fs.read("job_locks", "news")).toBeDefined(); // untouched
  });

  it("explains a stale lease and waits for the admin to agree to clear it", async () => {
    const { svc, fs, fetchMock, meta } = rig();
    fs.seed("job_locks", "news", lease());
    meta.news = { lastSyncedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() }; // finished after the lease began
    const r = await refusal(svc.requestRun("news", ADMIN, {}, NOW));
    expect(r).toMatchObject({ status: 409, body: { code: "JOB_LOCK_STALE" } });
    expect(String(r.body.message)).toMatch(/not running/);
    expect(fs.read("job_locks", "news")).toBeDefined(); // not cleared without consent
    expect(fs.ids(RUNS)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a second request for a job that is already queued or running", async () => {
    const { svc, fs, fetchMock } = rig();
    fs.seed(RUNS, "run00000000000000009", { job: "news", status: "running", requestedBy: "someone@else", requestedAt: new Date(NOW.getTime() - 60_000).toISOString() });
    const r = await refusal(svc.requestRun("news", ADMIN, {}, NOW));
    expect(r).toMatchObject({ status: 409, body: { code: "ALREADY_REQUESTED" } });
    expect(String(r.body.message)).toContain("someone@else");
    expect(fs.ids(RUNS)).toEqual(["run00000000000000009"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps how many manual runs may be in flight at once", async () => {
    const { svc, fs } = rig();
    for (let i = 0; i < MAX_RUNS_IN_FLIGHT; i++) {
      fs.seed(RUNS, `run0000000000000000${i}`, { job: `other-${i}`, status: "queued", requestedBy: "x", requestedAt: new Date(NOW.getTime() - 1000).toISOString() });
    }
    const r = await refusal(svc.requestRun("news", ADMIN, {}, NOW));
    expect(r).toMatchObject({ status: 429, body: { code: "TOO_MANY_RUNS" } });
  });

  it("does not count a run that was lost long ago against the cap or the job", async () => {
    const { svc, fs } = rig();
    const ancient = new Date(NOW.getTime() - RUN_LOST_AFTER_MS - 60_000).toISOString();
    fs.seed(RUNS, "run00000000000000007", { job: "news", status: "queued", requestedBy: "x", requestedAt: ancient });
    for (let i = 0; i < MAX_RUNS_IN_FLIGHT; i++) {
      fs.seed(RUNS, `run0000000000000000${i}`, { job: `other-${i}`, status: "running", requestedBy: "x", requestedAt: ancient });
    }
    await expect(svc.requestRun("news", ADMIN, {}, NOW)).resolves.toBeDefined();
  });

  it("lets only one of two simultaneous clicks through", async () => {
    const { svc, fs } = rig();
    const results = await Promise.allSettled([
      svc.requestRun("news", ADMIN, {}, NOW),
      svc.requestRun("news", ADMIN, {}, NOW),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as HttpException).getResponse()).toMatchObject({ code: "ALREADY_REQUESTED" });
    expect(fs.ids(RUNS)).toHaveLength(1);
  });
});

describe("JobsAdminService.requestRun — starting a run", () => {
  it("starts a Cloud Run Job execution and leaves an audit record saying who asked", async () => {
    const { svc, fs, fetchMock } = rig();
    const { run, message } = await svc.requestRun("news", ADMIN, {}, NOW);

    expect(run).toMatchObject({
      job: "news",
      status: "queued",
      transport: "cloud-run-job",
      requestedBy: ADMIN,
      requestedAt: NOW.toISOString(),
      executionName: "premarket-job-abc12",
      clearedStaleLock: false,
    });
    expect(message).toContain("Cloud Run Job premarket-job");

    const stored = fs.read(RUNS, run.id);
    expect(stored).toMatchObject({ job: "news", requestedBy: ADMIN, status: "queued", executionName: "premarket-job-abc12" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/jobs/premarket-job:run");
    const env = (JSON.parse(init.body as string).overrides.containerOverrides[0].env as Array<{ name: string; value: string }>);
    expect(env).toEqual([{ name: "SYNC_JOB", value: "news" }, { name: "ADMIN_RUN_ID", value: run.id }]);
  });

  it("clears a stale lease the admin agreed to clear, then runs", async () => {
    const { svc, fs, meta } = rig();
    fs.seed("job_locks", "news", lease());
    meta.news = { lastSyncedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() };
    const { run } = await svc.requestRun("news", ADMIN, { clearStaleLock: true }, NOW);
    expect(run.clearedStaleLock).toBe(true);
    expect(fs.read("job_locks", "news")).toBeUndefined();
  });

  it("does not clear the lease of a request the limits turned away", async () => {
    // The lease is only touched once nothing else can refuse the run.
    const { svc, fs, meta } = rig();
    fs.seed("job_locks", "news", lease());
    meta.news = { lastSyncedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() };
    for (let i = 0; i < MAX_RUNS_IN_FLIGHT; i++) {
      fs.seed(RUNS, `run0000000000000000${i}`, { job: `other-${i}`, status: "running", requestedBy: "x", requestedAt: new Date(NOW.getTime() - 1000).toISOString() });
    }
    const r = await refusal(svc.requestRun("news", ADMIN, { clearStaleLock: true }, NOW));
    expect(r.body.code).toBe("TOO_MANY_RUNS");
    expect(fs.read("job_locks", "news")).toBeDefined();
  });

  it("backs out if the lease changed hands between looking at it and clearing it", async () => {
    const { svc, fs, meta, fetchMock } = rig();
    fs.seed("job_locks", "news", lease());
    meta.news = { lastSyncedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() };
    const original = fs.runTransaction.bind(fs);
    let transactions = 0;
    jest.spyOn(fs, "runTransaction").mockImplementation(async (fn) => {
      transactions += 1;
      // The second transaction is the lease clear: a new run has taken it by then.
      if (transactions === 2) fs.seed("job_locks", "news", lease({ owner: "a-new-run" }));
      return original(fn);
    });

    const r = await refusal(svc.requestRun("news", ADMIN, { clearStaleLock: true }, NOW));
    expect(r).toMatchObject({ status: 409, body: { code: "JOB_LOCKED" } });
    expect(fs.read("job_locks", "news")?.owner).toBe("a-new-run"); // the new run's lease survives
    expect(fetchMock).not.toHaveBeenCalled();
    const [id] = fs.ids(RUNS);
    expect(fs.read(RUNS, id)?.status).toBe("dispatch-failed"); // the attempt is on the record
  });

  it("marks the run dispatch-failed and tells the admin why when Cloud Run refuses", async () => {
    const { svc, fs, fetchMock } = rig();
    fetchMock.mockImplementation(async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { message: "Permission 'run.jobs.runWithOverrides' denied" } }) }) as Response);
    const r = await refusal(svc.requestRun("news", ADMIN, {}, NOW));
    expect(r).toMatchObject({ status: 503, body: { code: "DISPATCH_FAILED" } });
    expect(String(r.body.message)).toContain("run.jobs.runWithOverrides");
    const [id] = fs.ids(RUNS);
    expect(fs.read(RUNS, id)).toMatchObject({ status: "dispatch-failed", requestedBy: ADMIN });
    expect(String(fs.read(RUNS, id)?.error)).toContain("runWithOverrides");
  });

  it("answers 502 when Cloud Run itself fails", async () => {
    const { svc, fetchMock } = rig();
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, text: async () => "internal" }) as Response);
    const r = await refusal(svc.requestRun("news", ADMIN, {}, NOW));
    expect(r.status).toBe(502);
  });

  it("runs in process where the job is registered, without touching Cloud Run", async () => {
    const { svc, fs, fetchMock } = rig({ registered: ["news"], env: { JOB_RUNNER_JOB: "" } });
    const { run, message } = await svc.requestRun("news", ADMIN, {}, NOW);
    expect(run.transport).toBe("in-process");
    expect(message).toContain("this server process");
    expect(fetchMock).not.toHaveBeenCalled();
    // the detached run finishes behind the response
    for (let i = 0; i < 200 && fs.read(RUNS, run.id)?.status !== "succeeded"; i++) await new Promise((r) => setImmediate(r));
    expect(fs.read(RUNS, run.id)?.status).toBe("succeeded");
    expect(fs.read("job_locks", "news")).toBeUndefined();
  });
});

describe("JobsAdminService.inventory", () => {
  it("lists every manifest job with its schedule, health, lease and latest manual run", async () => {
    const { svc, fs, meta } = rig();
    meta.news = { lastSyncedAt: "2026-10-30T14:00:00Z", lastStatus: "ok", lastCount: 40, runCount: 9 };
    meta["market-movers"] = { lastSyncedAt: "2026-10-30T13:00:00Z", lastStatus: "error", lastError: "FMP 503" };
    fs.seed("job_locks", "company-quotes", lease({ acquiredAt: NOW.getTime() - 60_000 }));
    fs.seed(RUNS, "run00000000000000001", { job: "news", status: "succeeded", requestedBy: ADMIN, requestedAt: "2026-10-30T13:00:00.000Z" });
    fs.seed(RUNS, "run00000000000000002", { job: "news", status: "failed", requestedBy: ADMIN, requestedAt: "2026-10-29T13:00:00.000Z" });

    const inv = await svc.inventory(NOW);
    const byName = Object.fromEntries(inv.jobs.map((j) => [j.name, j]));

    expect(inv.jobs.length).toBeGreaterThanOrEqual(50);
    expect(byName.news).toMatchObject({ health: "ok", lastCount: 40, trigger: "scheduler", timeZone: "America/New_York" });
    expect(byName.news.nextRunAt).toBe("2026-10-30T14:10:00.000Z");
    expect(byName.news.lastAdminRun).toMatchObject({ id: "run00000000000000001", status: "succeeded" }); // newest wins
    expect(byName["market-movers"]).toMatchObject({ health: "failing", lastError: "FMP 503" });
    expect(byName["company-quotes"].lock).toMatchObject({ owner: "scheduler-1", probablyStale: false });
    expect(byName["auto-purge"].risk).toMatchObject({ level: "destructive" });
    expect(byName["analyst-actions"].timeZone).toBe("America/Chicago");
    expect(inv.counts).toMatchObject({ failing: 1, running: 1 });
    expect(inv.counts.total).toBe(inv.jobs.length);
    expect(inv.runner).toMatchObject({ available: true, transport: "cloud-run-job" });
  });

  it("still returns the manifest when run history, leases or manual runs cannot be read", async () => {
    const { svc, fs } = rig({ metaDown: true });
    fs.failOn = () => new Error("firestore down");
    const inv = await svc.inventory(NOW);
    expect(inv.jobs.length).toBeGreaterThanOrEqual(50);
    expect(inv.metaError).toBe("sync_meta unavailable");
    expect(inv.lockError).toBe("firestore down");
    expect(inv.runsError).toBe("firestore down");
  });

  it("flags a lease that outlived its run so the admin can see why Run now is blocked", async () => {
    const { svc, fs, meta } = rig();
    fs.seed("job_locks", "news", lease());
    meta.news = { lastSyncedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), lastStatus: "ok" };
    const inv = await svc.inventory(NOW);
    const news = inv.jobs.find((j) => j.name === "news");
    expect(news.lock).toMatchObject({ probablyStale: true });
    expect(inv.counts.running).toBe(0); // a stale lease is not a running job
  });

  it("says what a job is: its place in premarket, what it feeds, what it writes", async () => {
    const { svc, meta } = rig();
    meta["earnings-actuals"] = { lastSyncedAt: "2026-10-30T13:00:00Z", lastStatus: "ok", collections: ["earnings_events"] };
    const inv = await svc.inventory(NOW);
    const byName = Object.fromEntries(inv.jobs.map((j) => [j.name, j]));

    expect(byName["fear-greed"].role).toMatchObject({ partOf: "premarket", step: { after: "market-breadth" } });
    expect(byName.premarket.role.steps?.[0].name).toBe("warm");
    const ea = byName["earnings-actuals"];
    expect(ea.feeds.some((f) => f.api === "GET /live/earnings-wire" && f.screens.some((s) => s.id === "commentary"))).toBe(true);
    expect(ea.writes).toContain("earnings_events");
    expect(ea.activity).toBeNull();
  });

  it("shows what a running job is doing: how long, who started it, and premarket's step progress", async () => {
    const { svc, fs, meta } = rig();
    const acquiredAt = NOW.getTime() - 4 * 60_000;
    fs.seed("job_locks", "premarket", { owner: "job-entry-1", acquiredAt, expiresAt: NOW.getTime() + 50 * 60_000 });
    meta["market-indices"] = { lastSyncedAt: new Date(acquiredAt + 30_000).toISOString(), lastStatus: "ok" };
    fs.seed(RUNS, "run00000000000000009", { job: "premarket", status: "running", requestedBy: ADMIN, requestedAt: new Date(acquiredAt - 5000).toISOString(), startedAt: new Date(acquiredAt).toISOString() });

    const inv = await svc.inventory(NOW);
    const pm = inv.jobs.find((j) => j.name === "premarket");
    expect(pm.activity).toMatchObject({
      state: "running",
      elapsedMs: 4 * 60_000,
      startedBy: { kind: "admin", by: ADMIN },
      current: "sectors",
    });
    expect(pm.activity.steps.find((s) => s.name === "market-indices").state).toBe("done");
    expect(inv.counts.running).toBe(1);
    expect(inv.jobs.filter((j) => j.activity).map((j) => j.name)).toEqual(["premarket"]);
  });

  it("explains an unavailable runner instead of failing", async () => {
    const { svc } = rig({ env: { JOB_RUNNER_JOB: "" } });
    const inv = await svc.inventory(NOW);
    expect(inv.runner.available).toBe(false);
    expect(inv.runner.reason).toMatch(/JOB_RUNNER_JOB/);
  });
});

describe("JobsAdminService.recentRuns", () => {
  it("returns newest first and clamps the limit", async () => {
    const { svc, fs } = rig();
    for (let i = 0; i < 5; i++) {
      fs.seed(RUNS, `run0000000000000000${i}`, { job: "news", status: "succeeded", requestedBy: ADMIN, requestedAt: `2026-10-30T1${i}:00:00.000Z` });
    }
    const runs = await svc.recentRuns(3, NOW.getTime());
    expect(runs.map((r) => r.id)).toEqual(["run00000000000000004", "run00000000000000003", "run00000000000000002"]);
    expect(await svc.recentRuns(0, NOW.getTime())).toHaveLength(5); // 0 falls back to the default, not "none"
    expect(await svc.recentRuns(10_000, NOW.getTime())).toHaveLength(5);
  });
});
