import { FakeFirestore } from "../../test/support/fake-firestore";
import {
  ADMIN_JOB_RUNS_COLLECTION as RUNS,
  RUN_LOST_AFTER_MS,
  describeResult,
  isValidRunId,
  outcomeFromSyncMeta,
  reportRunFinished,
  reportRunStarted,
  toRunView,
} from "./job-runs";

const asFirestore = (fs: FakeFirestore) => fs as unknown as Parameters<typeof reportRunStarted>[0];

describe("isValidRunId", () => {
  it("accepts a Firestore auto-id and nothing else", () => {
    expect(isValidRunId("abcdEFGH0123456789zZ")).toBe(true);
    expect(isValidRunId("short")).toBe(false);
    expect(isValidRunId("abcdEFGH0123456789zZ/../x")).toBe(false);
    expect(isValidRunId("has space 0123456789")).toBe(false);
    expect(isValidRunId(undefined)).toBe(false);
  });
});

describe("outcomeFromSyncMeta", () => {
  const started = Date.parse("2026-10-30T14:00:00Z");

  it("trusts what the job recorded over the fact that it returned normally", () => {
    // Most jobs catch their own errors, record them and RETURN — exit status
    // alone would call this a success.
    const out = outcomeFromSyncMeta(
      started,
      { lastSyncedAt: "2026-10-30T14:01:00Z", lastStatus: "error", lastError: "Polygon 429" },
      { ok: false },
    );
    expect(out).toEqual({ status: "failed", error: "Polygon 429" });
  });

  it("reports success with the count the job recorded", () => {
    const out = outcomeFromSyncMeta(
      started,
      { lastSyncedAt: "2026-10-30T14:01:00Z", lastStatus: "ok", lastCount: 312 },
      undefined,
    );
    expect(out).toEqual({ status: "succeeded", summary: "Synced 312 documents." });
  });

  it("ignores a run the job recorded BEFORE this one began", () => {
    // sync_meta still holds yesterday's error; this run recorded nothing.
    const out = outcomeFromSyncMeta(
      started,
      { lastSyncedAt: "2026-10-29T14:01:00Z", lastStatus: "error", lastError: "old" },
      { published: false, reason: "already-published" },
    );
    expect(out.status).toBe("skipped");
    expect(out.summary).toContain("already-published");
  });

  it("calls a run that recorded nothing and said nothing a completed one", () => {
    const out = outcomeFromSyncMeta(started, undefined, undefined);
    expect(out.status).toBe("succeeded");
    expect(out.summary).toMatch(/recorded no result/);
  });

  it("clips a very long error", () => {
    const out = outcomeFromSyncMeta(
      started,
      { lastSyncedAt: "2026-10-30T14:01:00Z", lastStatus: "error", lastError: "x".repeat(5000) },
      undefined,
    );
    expect(out.error.length).toBeLessThanOrEqual(400);
  });
});

describe("describeResult", () => {
  it("renders values briefly and never throws", () => {
    expect(describeResult(undefined)).toBeNull();
    expect(describeResult({ count: 3 })).toBe('{"count":3}');
    expect(describeResult("ok")).toBe("ok");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeResult(circular)).toBeNull();
    expect(describeResult("y".repeat(900)).length).toBeLessThanOrEqual(400);
  });
});

describe("toRunView", () => {
  const now = Date.parse("2026-10-30T18:00:00Z");
  const base = {
    job: "news",
    transport: "cloud-run-job",
    requestedBy: "admin@marketcatalyst.ai",
    requestedAt: "2026-10-30T17:30:00.000Z",
  };

  it("passes a recent in-flight run through", () => {
    expect(toRunView("id1", { ...base, status: "running" }, now).status).toBe("running");
  });

  it("calls a run still in flight after the task timeout lost, without storing that", () => {
    const old = new Date(now - RUN_LOST_AFTER_MS - 60_000).toISOString();
    expect(toRunView("id1", { ...base, requestedAt: old, status: "queued" }, now).status).toBe("lost");
    // A finished run is never "lost", however old.
    expect(toRunView("id1", { ...base, requestedAt: old, status: "succeeded" }, now).status).toBe("succeeded");
  });

  it("fills sensible defaults for a partial document", () => {
    const view = toRunView("id1", { job: "news" }, now);
    expect(view).toMatchObject({ id: "id1", job: "news", status: "queued", requestedBy: "unknown", error: null });
  });
});

describe("reportRunStarted / reportRunFinished", () => {
  const seed = (fs: FakeFirestore) =>
    fs.seed(RUNS, "run00000000000000001", { job: "news", status: "queued", error: "stale" });

  it("moves a run to running, then to its end state", async () => {
    const fs = new FakeFirestore();
    seed(fs);
    await reportRunStarted(asFirestore(fs), "run00000000000000001", { executionName: "premarket-job-abc12", attempt: 0 });
    expect(fs.read(RUNS, "run00000000000000001")).toMatchObject({
      status: "running",
      executionName: "premarket-job-abc12",
      attempt: 0,
      error: null, // a retry starts clean
    });
    await reportRunFinished(asFirestore(fs), "run00000000000000001", { status: "succeeded", summary: "Synced 5 documents." });
    expect(fs.read(RUNS, "run00000000000000001")).toMatchObject({ status: "succeeded", summary: "Synced 5 documents.", error: null });
    expect(typeof fs.read(RUNS, "run00000000000000001").finishedAt).toBe("string");
  });

  it("can never throw into the job that calls it", async () => {
    const fs = new FakeFirestore();
    seed(fs);
    fs.failOn = () => new Error("firestore down");
    await expect(reportRunStarted(asFirestore(fs), "run00000000000000001")).resolves.toBeUndefined();
    await expect(reportRunFinished(asFirestore(fs), "run00000000000000001", { status: "failed", error: "x" })).resolves.toBeUndefined();
    // Nor does a missing record (deleted, or a bad id) break it.
    fs.failOn = () => undefined;
    await expect(reportRunStarted(asFirestore(fs), "run99999999999999999")).resolves.toBeUndefined();
  });
});
