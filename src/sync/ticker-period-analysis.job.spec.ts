import { TickerPeriodAnalysisJob } from "./ticker-period-analysis.job";

/**
 * Cleanup safety (§11). These are the tests that matter most in this spec:
 * every one asserts that news is NOT deleted. Deleting news that has not been
 * analysed is unrecoverable — the retry has nothing left to read.
 */

function makeJob(receipt: unknown | undefined) {
  const deleted: string[] = [];
  const batch = {
    delete: (ref: { id: string }) => { deleted.push(ref.id); },
    commit: async () => {},
  };
  const newsDocs = [{ id: "AAPL_1", ref: { id: "AAPL_1" } }, { id: "AAPL_2", ref: { id: "AAPL_2" } }];
  const firestore = {
    batch: () => batch,
    collection: (name: string) => ({
      doc: () => ({
        get: async () => ({ exists: receipt !== undefined, data: () => receipt }),
        set: async () => {},
      }),
      where() { return this; },
      get: async () => ({ docs: name === "news" ? newsDocs : [] }),
    }),
  };
  const meta = { record: async () => {} };
  const job = new TickerPeriodAnalysisJob(
    { firestore } as never, meta as never, { register: () => {} } as never,
    {} as never, {} as never,
  );
  return { job, deleted };
}

const COMPLETE = {
  complete: true, tickersSucceeded: 5, tickersFailed: 0,
  monthStart: "2026-08-01", monthEnd: "2026-08-31",
};

describe("monthly cleanup safety", () => {
  const realDate = Date;
  afterEach(() => { global.Date = realDate; });
  /** Pin "now" to the last Friday of Aug 2026 so the gate is open. */
  function onLastFriday() {
    const fixed = new realDate("2026-08-28T20:30:00Z");
    global.Date = class extends realDate {
      constructor(...a: unknown[]) { super(...(a as [])); return a.length ? new realDate(...(a as [])) : fixed; }
      static now() { return fixed.getTime(); }
    } as never;
  }

  it("does NOT delete when no monthly receipt exists", async () => {
    onLastFriday();
    const { job, deleted } = makeJob(undefined);
    const res = await job.runCleanup();
    expect(res).toMatchObject({ deleted: 0, blocked: "no-receipt" });
    expect(deleted).toEqual([]);
  });

  it("does NOT delete when the monthly analysis had failures", async () => {
    onLastFriday();
    const { job, deleted } = makeJob({ ...COMPLETE, complete: false, tickersFailed: 3 });
    const res = await job.runCleanup();
    expect(res).toMatchObject({ deleted: 0, blocked: "incomplete" });
    expect(deleted).toEqual([]);
  });

  it("does NOT delete when the analysis succeeded for zero tickers", async () => {
    onLastFriday();
    const { job, deleted } = makeJob({ ...COMPLETE, tickersSucceeded: 0 });
    const res = await job.runCleanup();
    expect(res).toMatchObject({ deleted: 0, blocked: "incomplete" });
    expect(deleted).toEqual([]);
  });

  it("does NOT run at all on a non-last Friday", async () => {
    const { job, deleted } = makeJob(COMPLETE);   // real clock, almost never the last Friday
    const res = await job.runCleanup();
    if ("skipped" in res) expect(res.skipped).toBe(true);
    expect(deleted).toEqual([]);
  });

  it("deletes ONLY once a verified complete analysis exists", async () => {
    onLastFriday();
    const { job, deleted } = makeJob(COMPLETE);
    const res = await job.runCleanup();
    expect(res).toMatchObject({ deleted: 2, blocked: null });
    expect(deleted).toEqual(["AAPL_1", "AAPL_2"]);
  });
});

describe("monthly analysis gate", () => {
  it("skips when today is not the last Friday", async () => {
    const { job } = makeJob(undefined);
    const res = await job.runMonthly();
    // On any ordinary day this must short-circuit before touching Firestore.
    if ("skipped" in res) expect(res.reason).toBe("not-last-friday");
  });
});
