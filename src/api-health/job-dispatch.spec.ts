import { FakeFirestore } from "../../test/support/fake-firestore";
import {
  CloudRunJobDispatcher,
  DispatchError,
  InProcessDispatcher,
  describeRunner,
  executionNameFrom,
  pickDispatcher,
  readJobRunnerConfig,
  type DispatcherDeps,
  type JobRunnerConfig,
} from "./job-dispatch";
import { ADMIN_JOB_RUNS_COLLECTION as RUNS } from "./job-runs";

const asFs = (fs: FakeFirestore) => fs as unknown as ReturnType<InProcessDispatcherFs>;
type InProcessDispatcherFs = () => import("firebase-admin/firestore").Firestore;

const cfg: JobRunnerConfig = { projectId: "market-catalyst-502415", region: "us-central1", job: "premarket-job" };
const TOKEN = "ya29.super-secret-access-token";
const RUN_ID = "run00000000000000001";

function response(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as Response;
}

function dispatcher(fetchImpl: jest.Mock, overrides: Partial<{ token: () => Promise<string> }> = {}) {
  return new CloudRunJobDispatcher(
    cfg,
    overrides.token ?? (async () => TOKEN),
    "backend-runtime@market-catalyst-502415.iam.gserviceaccount.com",
    fetchImpl as unknown as typeof fetch,
  );
}

describe("readJobRunnerConfig", () => {
  const reader = (env: Record<string, string>) => ({ get: (k: string) => env[k] });

  it("is off — not an error — until a job is named", () => {
    expect(readJobRunnerConfig(reader({ FIREBASE_PROJECT_ID: "market-catalyst-502415" }))).toBeNull();
    expect(readJobRunnerConfig(reader({ JOB_RUNNER_JOB: "  " }))).toBeNull();
  });

  it("defaults the project to the one the service runs in, and the region to us-central1", () => {
    expect(readJobRunnerConfig(reader({ JOB_RUNNER_JOB: "premarket-job", FIREBASE_PROJECT_ID: "market-catalyst-502415" }))).toEqual(cfg);
  });

  it("lets every part be overridden", () => {
    expect(
      readJobRunnerConfig(
        reader({ JOB_RUNNER_JOB: "runner", JOB_RUNNER_REGION: "europe-west1", JOB_RUNNER_PROJECT_ID: "other-project-123", FIREBASE_PROJECT_ID: "ignored-project-1" }),
      ),
    ).toEqual({ projectId: "other-project-123", region: "europe-west1", job: "runner" });
  });

  it("refuses values that cannot be Cloud Run resource ids, since they go into a URL", () => {
    const ok = { FIREBASE_PROJECT_ID: "market-catalyst-502415" };
    expect(() => readJobRunnerConfig(reader({ ...ok, JOB_RUNNER_JOB: "../../etc" }))).toThrow(/not a valid Cloud Run Job name/);
    expect(() => readJobRunnerConfig(reader({ ...ok, JOB_RUNNER_JOB: "j", JOB_RUNNER_REGION: "us/central" }))).toThrow(/not a valid region/);
    expect(() => readJobRunnerConfig(reader({ JOB_RUNNER_JOB: "j" }))).toThrow(/project id/);
  });
});

describe("CloudRunJobDispatcher", () => {
  it("starts an execution of the runner job with SYNC_JOB and the run id overridden", async () => {
    const fetchImpl = jest.fn(async () =>
      response(200, { name: "projects/p/locations/us-central1/operations/op1", metadata: { name: "projects/p/locations/us-central1/jobs/premarket-job/executions/premarket-job-x7k2q" } }),
    );
    const out = await dispatcher(fetchImpl).dispatch({ job: "news", runId: RUN_ID });

    expect(out).toEqual({ executionName: "premarket-job-x7k2q" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://run.googleapis.com/v2/projects/market-catalyst-502415/locations/us-central1/jobs/premarket-job:run");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({
      overrides: { containerOverrides: [{ env: [{ name: "SYNC_JOB", value: "news" }, { name: "ADMIN_RUN_ID", value: RUN_ID }] }] },
    });
  });

  it("still succeeds when the response has no execution name", async () => {
    const out = await dispatcher(jest.fn(async () => response(200, "{}"))).dispatch({ job: "news", runId: RUN_ID });
    expect(out.executionName).toBeNull();
  });

  it("explains a permission failure and names the account that needs the grant", async () => {
    const fetchImpl = jest.fn(async () => response(403, { error: { message: "Permission 'run.jobs.runWithOverrides' denied on resource" } }));
    const err = (await dispatcher(fetchImpl).dispatch({ job: "news", runId: RUN_ID }).catch((e) => e)) as DispatchError;
    expect(err).toBeInstanceOf(DispatchError);
    expect(err.code).toBe("PERMISSION");
    expect(err.message).toContain("run.jobs.runWithOverrides");
    expect(err.message).toContain("backend-runtime@market-catalyst-502415.iam.gserviceaccount.com");
    expect(err.message).toContain("DEPLOY.md");
  });

  it("says which job, project and region were not found", async () => {
    const err = (await dispatcher(jest.fn(async () => response(404, { error: { message: "not found" } }))).dispatch({ job: "news", runId: RUN_ID }).catch((e) => e)) as DispatchError;
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toMatch(/premarket-job.*market-catalyst-502415.*us-central1/);
  });

  it("maps other failures to an upstream error without losing Google's reason", async () => {
    const err = (await dispatcher(jest.fn(async () => response(503, "backend unavailable"))).dispatch({ job: "news", runId: RUN_ID }).catch((e) => e)) as DispatchError;
    expect(err.code).toBe("UPSTREAM");
    expect(err.message).toContain("503");
    expect(err.message).toContain("backend unavailable");
  });

  it("reports a network failure, a timeout, and a token failure as upstream errors", async () => {
    const down = (await dispatcher(jest.fn(async () => { throw new Error("ECONNRESET"); })).dispatch({ job: "news", runId: RUN_ID }).catch((e) => e)) as DispatchError;
    expect(down.code).toBe("UPSTREAM");
    expect(down.message).toContain("ECONNRESET");

    const timeout = (await dispatcher(jest.fn(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); })).dispatch({ job: "news", runId: RUN_ID }).catch((e) => e)) as DispatchError;
    expect(timeout.message).toMatch(/did not answer within 15s/);

    const noToken = (await dispatcher(jest.fn(), { token: async () => { throw new Error("metadata server unreachable"); } }).dispatch({ job: "news", runId: RUN_ID }).catch((e) => e)) as DispatchError;
    expect(noToken.code).toBe("UPSTREAM");
    expect(noToken.message).toContain("metadata server unreachable");
  });

  it("never lets the access token reach an error message, even if the server echoes it", async () => {
    // The body of a failed call is copied into the message. A proxy that
    // reflects the Authorization header would put the bearer token there.
    const echoing = jest.fn(async () => response(401, { error: { message: `bad credential: Bearer ${TOKEN}` } }));
    const err = (await dispatcher(echoing).dispatch({ job: "news", runId: RUN_ID }).catch((e) => e)) as DispatchError;
    expect(err.message).toContain("[redacted]");
    expect(err.message).not.toContain(TOKEN);
  });

  it("refuses a job name that is not a plain registry name before touching the network", async () => {
    const fetchImpl = jest.fn();
    for (const bad of ["News", "a b", "a;b", "../x", "", "x\nSYNC_JOB=other"]) {
      await expect(dispatcher(fetchImpl).dispatch({ job: bad, runId: RUN_ID })).rejects.toBeInstanceOf(DispatchError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("executionNameFrom", () => {
  it("reduces a resource path to the execution id and shrugs at anything else", () => {
    expect(executionNameFrom(JSON.stringify({ metadata: { name: "projects/p/locations/r/jobs/j/executions/j-abc" } }))).toBe("j-abc");
    expect(executionNameFrom("not json")).toBeNull();
    expect(executionNameFrom(JSON.stringify({ metadata: {} }))).toBeNull();
  });
});

describe("InProcessDispatcher", () => {
  async function settled(fs: FakeFirestore, id: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 200; i++) {
      const d = fs.read(RUNS, id);
      if (d && ["succeeded", "failed", "skipped"].includes(d.status as string)) return d;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error("run never finished");
  }

  const build = (fs: FakeFirestore, runner: (() => Promise<unknown>) | undefined, meta: Record<string, unknown> = {}) =>
    new InProcessDispatcher({
      registry: { get: () => runner } as never,
      firestore: () => asFs(fs),
      readMeta: async () => meta,
    });

  it("runs the job behind the call, reports progress, and releases its lease", async () => {
    const fs = new FakeFirestore();
    fs.seed(RUNS, RUN_ID, { job: "news", status: "queued" });
    const run = jest.fn(async () => ({ count: 7 }));
    const meta = { lastSyncedAt: new Date(Date.now() + 5_000).toISOString(), lastStatus: "ok", lastCount: 7 };

    const out = await build(fs, run, meta).dispatch({ job: "news", runId: RUN_ID });
    expect(out).toEqual({ executionName: null });

    const done = await settled(fs, RUN_ID);
    expect(done).toMatchObject({ status: "succeeded", summary: "Synced 7 documents." });
    expect(run).toHaveBeenCalledTimes(1);
    expect(fs.read("job_locks", "news")).toBeUndefined(); // lease released
  });

  it("records a failure and still releases the lease", async () => {
    const fs = new FakeFirestore();
    fs.seed(RUNS, RUN_ID, { job: "news", status: "queued" });
    await build(fs, async () => { throw new Error("vendor exploded"); }).dispatch({ job: "news", runId: RUN_ID });
    expect(await settled(fs, RUN_ID)).toMatchObject({ status: "failed", error: "vendor exploded" });
    expect(fs.read("job_locks", "news")).toBeUndefined();
  });

  it("does not start a job whose lease another process holds", async () => {
    const fs = new FakeFirestore();
    fs.seed("job_locks", "news", { owner: "scheduler-run", acquiredAt: Date.now() - 1000, expiresAt: Date.now() + 600_000 });
    const run = jest.fn();
    const err = (await build(fs, run).dispatch({ job: "news", runId: RUN_ID }).catch((e) => e)) as DispatchError;
    expect(err.code).toBe("LOCKED");
    expect(run).not.toHaveBeenCalled();
    expect(fs.read("job_locks", "news")?.owner).toBe("scheduler-run"); // untouched
  });

  it("rejects a job it has no runner for", async () => {
    const err = (await build(new FakeFirestore(), undefined).dispatch({ job: "news", runId: RUN_ID }).catch((e) => e)) as DispatchError;
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("choosing a transport", () => {
  const deps = (over: Partial<DispatcherDeps>): DispatcherDeps => ({
    registry: { get: () => undefined, names: () => [] },
    runnerConfig: null,
    inProcess: { registry: { get: () => undefined } as never, firestore: () => { throw new Error("unused"); }, readMeta: async () => ({}) },
    getAccessToken: async () => TOKEN,
    identity: "me",
    ...over,
  });
  const hasJob = { get: () => async () => undefined, names: () => ["news"] };

  it("runs in process wherever the job is registered (the worker, a dev machine)", () => {
    expect(pickDispatcher("news", deps({ registry: hasJob as never, runnerConfig: cfg }))?.transport).toBe("in-process");
    expect(describeRunner(deps({ registry: hasJob as never })).transport).toBe("in-process");
  });

  it("starts a Cloud Run Job execution from the live role, which registers no jobs", () => {
    expect(pickDispatcher("news", deps({ runnerConfig: cfg }))?.transport).toBe("cloud-run-job");
    expect(describeRunner(deps({ runnerConfig: cfg }))).toMatchObject({
      available: true,
      transport: "cloud-run-job",
      target: "Cloud Run Job premarket-job (us-central1)",
    });
  });

  it("has no transport when neither applies, and says how to set one up", () => {
    expect(pickDispatcher("news", deps({}))).toBeNull();
    const status = describeRunner(deps({}));
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/JOB_RUNNER_JOB/);
    expect(status.reason).toMatch(/DEPLOY\.md/);
  });
});
