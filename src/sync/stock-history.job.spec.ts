import {
  perTickerWindows,
  routeTicker,
  StockHistoryJob,
  weekdaysBefore,
} from "./stock-history.job";
import { batchSetWithCreatedAt } from "../common/firestore-batch.util";
import * as fs from "fs";
import * as path from "path";

jest.mock("../common/firestore-batch.util", () => ({
  batchSetWithCreatedAt: jest.fn().mockResolvedValue(undefined),
}));
const writes = batchSetWithCreatedAt as jest.Mock;

describe("weekdaysBefore", () => {
  it("returns the newest weekdays before today, oldest first, skipping weekends", () => {
    // 2026-10-13 is a Tuesday.
    expect(weekdaysBefore("2026-10-13", 4)).toEqual([
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-12",
    ]);
  });

  it("never includes today", () => {
    expect(weekdaysBefore("2026-10-13", 1)).toEqual(["2026-10-12"]);
  });
});

describe("routeTicker", () => {
  const windowStart = "2026-09-29";

  it("sends a ticker whose gap is inside the window to grouped-daily", () => {
    expect(
      routeTicker({
        watermark: "2026-10-08",
        needsDeepFill: false,
        windowStart,
      }),
    ).toBe("grouped");
    // Gap starts exactly at the window's first session.
    expect(
      routeTicker({
        watermark: "2026-09-28",
        needsDeepFill: false,
        windowStart,
      }),
    ).toBe("grouped");
  });

  it("sends deep fills, never-synced and long-stale tickers per-ticker", () => {
    expect(
      routeTicker({
        watermark: "2026-10-08",
        needsDeepFill: true,
        windowStart,
      }),
    ).toBe("per-ticker");
    expect(
      routeTicker({ watermark: null, needsDeepFill: false, windowStart }),
    ).toBe("per-ticker");
    expect(
      routeTicker({
        watermark: "2026-09-20",
        needsDeepFill: false,
        windowStart,
      }),
    ).toBe("per-ticker");
  });
});

/** The private method under test. */
type SyncGrouped = (
  watermarks: Map<string, string>,
  dates: string[],
  today: string,
  missingDates?: Set<string>,
  universe?: Set<string>,
  queued?: Set<string>,
) => Promise<{ coveredThrough: string | null; rejected: number }>;

describe("StockHistoryJob.syncGrouped", () => {
  const bar = (T: string, c: number) => ({
    T,
    o: c,
    h: c,
    l: c,
    c,
    v: 1000.4,
    vw: c,
    t: 0,
  });

  function makeJob(grouped: Record<string, unknown[] | Error>) {
    const doc = (id: string) => ({ id });
    const firestore = {
      collection: (name: string) => ({
        doc: (id: string) => doc(`${name}/${id}`),
      }),
    };
    const polygon = {
      getGroupedDaily: jest.fn((date: string) => {
        const r = grouped[date] ?? [];
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      }),
    };
    const job = new StockHistoryJob(
      {} as never,
      { firestore } as never,
      {} as never,
      {} as never,
      polygon as never,
    );
    return { job: job as unknown as { syncGrouped: SyncGrouped }, polygon };
  }

  /** ids written to a collection, across all batchSetWithCreatedAt calls. */
  const written = (collection: string) =>
    writes.mock.calls
      .flatMap(
        ([, w]) =>
          w as Array<{ ref: { id: string }; data: Record<string, unknown> }>,
      )
      .filter((w) => w.ref.id.startsWith(`${collection}/`));

  beforeEach(() => writes.mockClear());

  it("fills PMI's missing 10-09 and advances every watermark to the newest session", async () => {
    const { job } = makeJob({
      "2026-10-09": [bar("PMI", 9.48), bar("AAPL", 250), bar("ZZZZ", 1)],
      "2026-10-12": [bar("PMI", 11.34), bar("AAPL", 251)],
    });
    const wm = new Map([
      ["PMI", "2026-10-08"],
      ["AAPL", "2026-10-09"],
    ]);
    const r = await job.syncGrouped(
      wm,
      ["2026-10-08", "2026-10-09", "2026-10-12"],
      "2026-10-13",
    );

    const bars = written("ohlcv_bars")
      .map((w) => w.ref.id)
      .sort();
    // AAPL already had 10-09; ZZZZ is not in the universe.
    expect(bars).toEqual([
      "ohlcv_bars/AAPL_2026-10-12",
      "ohlcv_bars/PMI_2026-10-09",
      "ohlcv_bars/PMI_2026-10-12",
    ]);
    const pmi = written("ohlcv_bars").find((w) =>
      w.ref.id.endsWith("PMI_2026-10-09"),
    );
    expect(pmi.data).toMatchObject({
      close: 9.48,
      volume: 1000,
      source: "polygon-grouped",
    });

    const marks = written("sync_watermarks").map((w) => [
      w.ref.id,
      w.data.lastSyncedThrough,
    ]);
    expect(marks).toEqual([
      ["sync_watermarks/stock-history__PMI", "2026-10-12"],
      ["sync_watermarks/stock-history__AAPL", "2026-10-12"],
    ]);
    expect(r.coveredThrough).toBe("2026-10-12");
  });

  it("does not ask for sessions every ticker already has", async () => {
    const { job, polygon } = makeJob({});
    await job.syncGrouped(
      new Map([["AAPL", "2026-10-09"]]),
      ["2026-10-08", "2026-10-09", "2026-10-12"],
      "2026-10-13",
    );
    expect(polygon.getGroupedDaily.mock.calls.map((c) => c[0])).toEqual([
      "2026-10-12",
    ]);
  });

  it("steps over a holiday but leaves a trailing empty session open", async () => {
    const { job } = makeJob({
      "2026-10-08": [], // holiday — a later session has bars
      "2026-10-09": [bar("PMI", 9.48)],
      "2026-10-12": [], // not published yet
    });
    const r = await job.syncGrouped(
      new Map([["PMI", "2026-10-07"]]),
      ["2026-10-08", "2026-10-09", "2026-10-12"],
      "2026-10-13",
    );
    expect(r.coveredThrough).toBe("2026-10-09");
    expect(written("sync_watermarks")[0].data.lastSyncedThrough).toBe(
      "2026-10-09",
    );
  });

  it("stops at a failed request so no watermark moves past the hole", async () => {
    const { job, polygon } = makeJob({
      "2026-10-08": [bar("PMI", 9.68)],
      "2026-10-09": new Error("503"),
      "2026-10-12": [bar("PMI", 11.34)],
    });
    const r = await job.syncGrouped(
      new Map([["PMI", "2026-10-07"]]),
      ["2026-10-08", "2026-10-09", "2026-10-12"],
      "2026-10-13",
    );
    expect(polygon.getGroupedDaily).toHaveBeenCalledTimes(2);
    expect(r.coveredThrough).toBe("2026-10-08");
    expect(written("ohlcv_bars").map((w) => w.ref.id)).toEqual([
      "ohlcv_bars/PMI_2026-10-08",
    ]);
  });

  it("drops an implausible bar", async () => {
    const { job } = makeJob({
      "2026-10-12": [{ ...bar("PMI", 11), h: 10 }], // close above high
    });
    const r = await job.syncGrouped(
      new Map([["PMI", "2026-10-09"]]),
      ["2026-10-12"],
      "2026-10-13",
    );
    expect(r.rejected).toBe(1);
    expect(written("ohlcv_bars")).toHaveLength(0);
  });

  it("back-fills a missing interior session even when ticker watermark has already advanced past it", async () => {
    const { job } = makeJob({
      "2026-10-09": [bar("AAPL", 250), bar("MSFT", 400)],
      "2026-10-12": [bar("AAPL", 252), bar("MSFT", 405)],
    });
    // AAPL's watermark is 2026-10-12, but 2026-10-09 was missing from stored bars
    const wm = new Map([
      ["AAPL", "2026-10-12"],
      ["MSFT", "2026-10-08"],
    ]);
    const missingDates = new Set(["2026-10-09"]);
    const universe = new Set(["AAPL", "MSFT"]);
    const r = await (job as any).syncGrouped(
      wm,
      ["2026-10-08", "2026-10-09", "2026-10-12"],
      "2026-10-13",
      missingDates,
      universe,
    );

    const bars = written("ohlcv_bars")
      .map((w) => w.ref.id)
      .sort();
    // AAPL must have 10-09 back-filled!
    expect(bars).toContain("ohlcv_bars/AAPL_2026-10-09");
    expect(bars).toContain("ohlcv_bars/MSFT_2026-10-09");
    expect(bars).toContain("ohlcv_bars/MSFT_2026-10-12");
  });
});

describe("StockHistoryJob.syncGrouped — tickers waiting in the per-ticker queue", () => {
  /**
   * Real Polygon grouped-daily rows (Oct 22/23) and FMP daily closes (Oct 14–22)
   * from validation-output/trace_HIJKL. On Oct 26 TTMI/VICR/DOCN's stored bars
   * ended Oct 22 (all source "polygon", the per-ticker path) although the
   * grouped response for Oct 23 carried them, so the 5-day move ran Oct 15 →
   * Oct 22 (−27.1 / −18.16 / −15.96). Public, Oct 16 → Oct 23: −14.67 / −8.07 / −5.54.
   */
  const fx = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures/weekly-movers-oct23.json"), "utf-8"),
  );

  function makeJob() {
    const firestore = {
      collection: (name: string) => ({ doc: (id: string) => ({ id: `${name}/${id}` }) }),
    };
    const polygon = {
      getGroupedDaily: jest.fn((date: string) => Promise.resolve(fx.grouped[date] ?? [])),
    };
    const job = new StockHistoryJob({} as never, { firestore } as never, {} as never, {} as never, polygon as never);
    return job as unknown as { syncGrouped: SyncGrouped };
  }
  const written = (collection: string) =>
    writes.mock.calls
      .flatMap(([, w]) => w as Array<{ ref: { id: string }; data: Record<string, number> }>)
      .filter((w) => w.ref.id.startsWith(`${collection}/`));

  beforeEach(() => writes.mockClear());

  it.each([
    ["TTMI", -14.67],
    ["VICR", -8.07],
    ["DOCN", -5.54],
  ])("%s gets its Oct 23 bar and a 5-day move of %s", async (ticker, publicPct) => {
    const job = makeJob();
    const queued = new Set(["TTMI", "VICR", "DOCN"]);
    await job.syncGrouped(
      new Map([["SPY", "2026-10-22"]]),
      ["2026-10-22", "2026-10-23"],
      "2026-10-26",
      new Set(),
      new Set(["SPY", "TTMI", "VICR", "DOCN"]),
      queued,
    );
    const bar = written("ohlcv_bars").find((w) => w.ref.id === `ohlcv_bars/${ticker}_2026-10-23`);
    expect(bar).toBeDefined();
    const closes = [
      ...fx.priorBars[ticker].map((b: { close: number }) => b.close),
      bar!.data.close,
    ];
    const pct = (closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100;
    expect(Math.round(pct * 100) / 100).toBe(publicPct);
    // The per-ticker path still owns these tickers' gap and deep fill.
    expect(written("sync_watermarks").map((w) => w.ref.id)).not.toContain(
      `sync_watermarks/stock-history__${ticker}`,
    );
  });
});

describe("perTickerWindows", () => {
  const base = {
    earliestSyncedFrom: "2021-10-15",
    stranded: false,
    today: "2026-10-15",
    floor: "2021-10-15",
    backfillFrom: "2024-10-15",
  };

  it("never fetches today: the forward window ends at the last completed session", () => {
    // A run during market hours used to store today's forming bar (UNH, 15 Sep:
    // 110,203 shares at 09:49 against a real 4,393,582) and never revisit it.
    const { windows } = perTickerWindows({ ...base, watermark: "2026-10-12" });
    expect(windows).toEqual([["2026-10-13", "2026-10-14"]]);
  });

  it("asks for nothing when the watermark is already the last completed session", () => {
    const { windows } = perTickerWindows({ ...base, watermark: "2026-10-14" });
    expect(windows).toEqual([]);
  });

  it("a never-synced ticker's deep fill also stops before today", () => {
    const { windows, needsDeepFill } = perTickerWindows({
      ...base,
      watermark: null,
      earliestSyncedFrom: null,
    });
    expect(needsDeepFill).toBe(true);
    for (const [, to] of windows) expect(to < "2026-10-15").toBe(true);
    expect(windows).toContainEqual(["2021-10-15", "2026-10-14"]);
  });

  it("a stranded ticker is refilled through the last completed session", () => {
    const { windows } = perTickerWindows({ ...base, watermark: "2026-10-14", stranded: true });
    expect(windows).toEqual([["2021-10-15", "2026-10-14"]]);
  });

  it("the backward window still stops the day before the known edge", () => {
    const { windows } = perTickerWindows({
      ...base,
      watermark: "2026-10-14",
      earliestSyncedFrom: "2023-01-03",
    });
    expect(windows).toEqual([["2021-10-15", "2023-01-02"]]);
  });
});
