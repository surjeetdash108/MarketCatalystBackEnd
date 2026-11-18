import { splitsToReadjust, StockHistoryJob } from "./stock-history.job";

/**
 * Error 13 (LOBO 10-for-1 reverse split, executed 2026-11-17): the 52-week low
 * ($0.33), high and 5-day base stayed on the pre-split basis because the daily
 * increment appended post-split bars to pre-split history. corporate-actions
 * only reaches each ticker every few months (40 a day) and only baselines on
 * first sight, so the re-backfill never fired.
 */
describe("splitsToReadjust", () => {
  const universe = new Set(["LOBO", "AAPL"]);
  it("a recent split on a tracked ticker that hasn't been handled is re-adjusted", () => {
    const out = splitsToReadjust(
      [{ ticker: "LOBO", executionDate: "2026-11-17", splitFrom: 10, splitTo: 1 }],
      universe,
      new Map(),
    );
    expect(out).toEqual([{ ticker: "LOBO", executionDate: "2026-11-17" }]);
  });
  it("skips untracked tickers and splits already reflected", () => {
    const out = splitsToReadjust(
      [
        { ticker: "ZZZZ", executionDate: "2026-11-17", splitFrom: 1, splitTo: 2 },
        { ticker: "AAPL", executionDate: "2026-11-16", splitFrom: 1, splitTo: 4 },
      ],
      universe,
      new Map([["AAPL", "2026-11-16"]]),
    );
    expect(out).toEqual([]);
  });
  it("one entry per ticker (its newest split)", () => {
    const out = splitsToReadjust(
      [
        { ticker: "LOBO", executionDate: "2026-11-14", splitFrom: 1, splitTo: 2 },
        { ticker: "LOBO", executionDate: "2026-11-17", splitFrom: 10, splitTo: 1 },
      ],
      universe,
      new Map(),
    );
    expect(out).toEqual([{ ticker: "LOBO", executionDate: "2026-11-17" }]);
  });
});

describe("StockHistoryJob.readjustRecentSplits", () => {
  const before = process.env.SPLIT_READJUST_ENABLED;
  beforeAll(() => { process.env.SPLIT_READJUST_ENABLED = "true"; });
  afterAll(() => { process.env.SPLIT_READJUST_ENABLED = before; });
  it("clears the ticker's synced range, marks the split handled, and returns it for a deep fill", async () => {
    const cleared: string[] = [];
    const marked: Array<[string, string, string]> = [];
    const meta = {
      clearSyncedRange: jest.fn((job: string, t: string) => { cleared.push(`${job}__${t}`); return Promise.resolve(); }),
      setWatermark: jest.fn((job: string, t: string, d: string) => { marked.push([job, t, d]); return Promise.resolve(); }),
      getSyncedRange: jest.fn(() => Promise.resolve({ lastSyncedThrough: null, earliestSyncedFrom: null })),
    };
    const polygon = {
      getSplitsInRange: jest.fn(() => Promise.resolve([{ ticker: "LOBO", executionDate: "2026-11-17", splitFrom: 10, splitTo: 1 }])),
    };
    const job = new StockHistoryJob({} as never, { firestore: {} } as never, meta as never, {} as never, polygon as never);
    const ranges = new Map([["LOBO", { lastSyncedThrough: "2026-11-17", earliestSyncedFrom: "2021-10-10" }]]);
    const out = await (job as unknown as {
      readjustRecentSplits: (t: string[], today: string, r: typeof ranges) => Promise<string[]>;
    }).readjustRecentSplits(["LOBO", "AAPL"], "2026-11-18", ranges);
    expect(out).toEqual(["LOBO"]);
    expect(cleared).toEqual(["stock-history__LOBO"]);
    expect(marked).toEqual([["corporate-actions", "LOBO", "2026-11-17"]]);
    expect(ranges.get("LOBO")).toEqual({ lastSyncedThrough: null, earliestSyncedFrom: null });
    expect(polygon.getSplitsInRange).toHaveBeenCalledWith("2026-11-11", "2026-11-18");
  });

  it("a failed splits call changes nothing", async () => {
    const meta = { clearSyncedRange: jest.fn(), setWatermark: jest.fn(), getSyncedRange: jest.fn() };
    const polygon = { getSplitsInRange: jest.fn(() => Promise.reject(new Error("503"))) };
    const job = new StockHistoryJob({} as never, { firestore: {} } as never, meta as never, {} as never, polygon as never);
    const out = await (job as unknown as {
      readjustRecentSplits: (t: string[], today: string, r: Map<string, unknown>) => Promise<string[]>;
    }).readjustRecentSplits(["LOBO"], "2026-11-18", new Map());
    expect(out).toEqual([]);
    expect(meta.clearSyncedRange).not.toHaveBeenCalled();
  });
});
