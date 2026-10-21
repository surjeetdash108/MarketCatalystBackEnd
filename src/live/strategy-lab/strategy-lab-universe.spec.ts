import {
  aggregateIntraday,
  decodePack,
  encodePack,
  indexAtOrAfter,
  mergeRows,
  packFromRows,
  packToEngineBars,
  packToRows,
  type LabBar,
} from "./bar-pack";
import {
  canonical,
  computeRun,
  normalizeCfg,
  runKey,
  sourceFor,
  LabResultsService,
} from "./lab-results.service";
import { windowStats } from "./universe-runner";
import {
  lastCompletedSession,
  parseBulkEod,
  weekdaysBetween,
} from "../../sync/strategy-lab-daily.job";
import { inSession } from "../../sync/strategy-lab-intraday.job";

const day = (i: number) =>
  new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
/** n daily bars rising 1% a day from 100. */
const rising = (n: number): LabBar[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 100 * 1.01 ** i;
    return [day(i), c, c * 1.01, c * 0.99, c, 1000 + i];
  });

describe("bar packs", () => {
  it("round-trip daily and intraday rows exactly through the Firestore encoding", () => {
    const d: LabBar[] = [
      ["2026-10-19", 1.5, 2, 1, 1.75, 100],
      ["2026-10-20", 1.75, 2.5, 1.5, 2.25, 200],
    ];
    expect(packToRows(decodePack(encodePack(packFromRows(d, false))))).toEqual(
      d,
    );
    const i: LabBar[] = [
      ["2026-10-21 09:30:00", 10, 11, 9, 10.5, 5],
      ["2026-10-21 09:35:00", 10.5, 12, 10, 11.75, 7],
    ];
    const p = decodePack(encodePack(packFromRows(i, true)));
    expect(packToRows(p)).toEqual(i);
    expect(packToEngineBars(p)[1]).toEqual({
      date: "2026-10-21 09:35:00",
      open: 10.5,
      high: 12,
      low: 10,
      close: 11.75,
      volume: 7,
    });
    expect(indexAtOrAfter(p, Date.parse("2026-10-21T09:31:00Z"))).toBe(1);
  });

  it("merges new bars over old ones on the same timestamp and trims old history", () => {
    const old: LabBar[] = [
      ["2026-10-16", 1, 1, 1, 1, 1],
      ["2026-10-19", 2, 2, 2, 2, 2],
    ];
    const add: LabBar[] = [
      ["2026-10-19", 3, 3, 3, 3, 3],
      ["2026-10-20", 4, 4, 4, 4, 4],
    ];
    expect(
      mergeRows(old, add, Date.parse("2026-10-17T00:00:00Z")).map((r) => [
        r[0],
        r[4],
      ]),
    ).toEqual([
      ["2026-10-19", 3],
      ["2026-10-20", 4],
    ]);
  });

  it("aggregates 15-min bars into session-aligned 30-min / 1-hour / 4-hour candles", () => {
    const b = ["09:30", "09:45", "10:00", "10:15", "10:30"].map((t, i) => ({
      date: `2026-10-21 ${t}:00`,
      open: 10 + i,
      high: 20 + i,
      low: 5 - i,
      close: 11 + i,
      volume: 1,
    }));
    expect(
      aggregateIntraday(b, 30).map((x) => [
        x.date,
        x.open,
        x.high,
        x.low,
        x.close,
        x.volume,
      ]),
    ).toEqual([
      ["2026-10-21 09:30:00", 10, 21, 4, 12, 2],
      ["2026-10-21 10:00:00", 12, 23, 2, 14, 2],
      ["2026-10-21 10:30:00", 14, 24, 1, 15, 1],
    ]);
    expect(aggregateIntraday(b, 60).map((x) => x.date)).toEqual([
      "2026-10-21 09:30:00",
      "2026-10-21 10:30:00",
    ]);
    expect(aggregateIntraday(b, 240).map((x) => x.date)).toEqual([
      "2026-10-21 09:30:00",
    ]);
  });
});

describe("daily job helpers", () => {
  it("parses eod-bulk by header name (its column order is open, low, high, close) and maps class shares", () => {
    const csv =
      '"symbol","date","open","low","high","close","adjClose","volume"\n"BRK-B","2026-10-20",534.25,533.5,541,539.82,539.82,5315276\n"ZZZ","2026-10-20",1,1,1,1,1,1\n"AAPL","2026-10-20",339.86,338.7,343.06,339.5,339.5,35851382';
    const m = parseBulkEod(csv, new Set(["BRK.B", "AAPL"]));
    expect(m.get("BRK.B")).toEqual([
      "2026-10-20",
      534.25,
      541,
      533.5,
      539.82,
      5315276,
    ]);
    expect(m.get("AAPL")).toEqual([
      "2026-10-20",
      339.86,
      343.06,
      338.7,
      339.5,
      35851382,
    ]);
    expect(m.has("ZZZ")).toBe(false);
  });

  it("knows the last finished session and the weekdays to patch", () => {
    expect(lastCompletedSession(Date.parse("2026-10-21T14:00:00Z"))).toBe(
      "2026-10-20",
    ); // Wed 10:00 ET
    expect(lastCompletedSession(Date.parse("2026-10-21T21:00:00Z"))).toBe(
      "2026-10-21",
    ); // Wed 17:00 ET
    expect(lastCompletedSession(Date.parse("2026-10-19T14:00:00Z"))).toBe(
      "2026-10-16",
    ); // Mon morning → Fri
    expect(weekdaysBetween("2026-10-15", "2026-10-20")).toEqual([
      "2026-10-16",
      "2026-10-19",
      "2026-10-20",
    ]);
    expect(inSession(Date.parse("2026-10-21T15:00:00Z"))).toBe(true); // 11:00 ET
    expect(inSession(Date.parse("2026-10-25T15:00:00Z"))).toBe(false); // Sunday
  });
});

describe("universe runs", () => {
  const spec = {
    entry: [{ a: { ind: "close" }, op: ">", b: { ind: "sma", n: 50 } }],
    exit: [{ a: { ind: "close" }, op: "<", b: { ind: "sma", n: 20 } }],
  };

  it("hashes equal rules + settings the same regardless of key order", () => {
    const cfg = normalizeCfg("d", {
      stop: 0.08,
      tp: null,
      trail: null,
      costBps: 5,
      years: 5,
    });
    const flipped = {
      exit: [{ b: { n: 20, ind: "sma" }, op: "<", a: { ind: "close" } }],
      entry: [{ op: ">", b: { n: 50, ind: "sma" }, a: { ind: "close" } }],
    };
    expect(runKey(spec, "d", cfg)).toBe(runKey(flipped, "d", cfg));
    expect(runKey(spec, "d", cfg)).not.toBe(
      runKey(spec, "d", { ...cfg, stop: 0.05 }),
    );
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      '{"a":[2,{"c":4,"d":3}],"b":1}',
    );
  });

  it("serves candle sizes from stored bars and explains the ones it can't", () => {
    expect(sourceFor("d", normalizeCfg("d", {}))).toEqual({ kind: "daily" });
    expect(sourceFor("1w", normalizeCfg("1w", {}))).toEqual({ kind: "daily" });
    expect(sourceFor("5m", normalizeCfg("5m", { idays: 21 }))).toEqual({
      kind: "intraday",
      packTf: "5m",
    });
    expect(sourceFor("1h", normalizeCfg("1h", { idays: 90 }))).toEqual({
      kind: "intraday",
      packTf: "15m",
      agg: 60,
    });
    expect(sourceFor("1h", normalizeCfg("1h", { idays: 180 }))).toHaveProperty(
      "error",
    );
    expect(sourceFor("1m", normalizeCfg("1m", { idays: 5 }))).toHaveProperty(
      "error",
    );
  });

  it("runs every stock, keeps only ready/setup rows, counts stocks without data", () => {
    const packs = new Map([
      ["UP", packFromRows(rising(400), false)],
      ["SHORT", packFromRows(rising(100), false)],
    ]);
    const run = computeRun(
      [
        { t: "UP", n: "Up Inc" },
        { t: "SHORT", n: "Short" },
        { t: "NONE", n: "None" },
      ],
      (t) => packs.get(t),
      spec,
      "d",
      normalizeCfg("d", { years: 1 }),
      "k",
      "2021-02-04",
      Date.parse("2021-02-05T00:00:00Z"),
    );
    expect(run).toMatchObject({ universe: 3, tested: 1, unavailable: 1 });
    expect(run.rows.map((r) => [r.t, r.st])).toEqual([["UP", "ready"]]);
    expect(run.rows[0].w["30"]).toHaveLength(4);
  });

  it("minute windows use bar timestamps (the engine folds intraday equity to days)", () => {
    const bars = ["09:30", "09:35", "09:40", "09:45"].map((t, i) => ({
      date: `2026-10-21 ${t}:00`,
      open: 100,
      high: 100,
      low: 100,
      close: 100 + i,
      volume: 1,
    }));
    const r = {
      eq: [{ date: "2026-10-21", v: 10_000 }],
      bh: [{ date: "2026-10-21", v: 10_000 }],
      trades: [{ outDate: "2026-10-21 09:45:00", ret: 0.02, why: "Exit: x" }],
    };
    const w = windowStats(r, bars, "5m");
    expect(w["15"][1]).toBeCloseTo(103 / 100 - 1); // close 09:45 vs the bar before the 09:30 cut… base is 09:30
    expect(w["15"].slice(2)).toEqual([1, 1]);
    expect(w["390"][0]).toBeCloseTo(0.02);
  });
});

describe("LabResultsService cache", () => {
  const spec = {
    entry: [{ a: { ind: "close" }, op: ">", b: { ind: "sma", n: 50 } }],
    exit: [],
  };
  const make = (cached: unknown, metaAsOf: string | null) => {
    const docs = new Map<string, unknown>(cached ? [["any", cached]] : []);
    const set = jest.fn(async () => undefined);
    const firebase = {
      firestore: {
        collection: () => ({
          doc: () => ({
            get: async () => ({
              exists: docs.size > 0,
              data: () => [...docs.values()][0],
            }),
            set,
          }),
        }),
      },
    };
    const store = {
      getMeta: jest.fn(async () => (metaAsOf ? { asOf: metaAsOf } : null)),
      universe: jest.fn(async () => [{ t: "UP", n: "Up" }]),
      allDaily: jest.fn(async () => ({
        asOf: metaAsOf,
        packs: new Map([["UP", packFromRows(rising(400), false)]]),
      })),
    };
    return {
      svc: new LabResultsService(firebase as never, store as never),
      store,
      set,
    };
  };

  it("returns the stored result while the data hasn't moved on", async () => {
    const { svc, store } = make(
      { asOf: "2026-10-20", rows: [], key: "x" },
      "2026-10-20",
    );
    await expect(svc.validate(spec, "d", {})).resolves.toMatchObject({
      asOf: "2026-10-20",
    });
    expect(store.allDaily).not.toHaveBeenCalled();
  });

  it("recomputes and stores when the stored result is older than the data", async () => {
    const { svc, store, set } = make(
      { asOf: "2026-10-17", rows: [] },
      "2026-10-20",
    );
    const run = await svc.validate(spec, "d", {});
    expect(store.allDaily).toHaveBeenCalled();
    expect(set).toHaveBeenCalled();
    expect(run).toMatchObject({ asOf: "2026-10-20", universe: 1 });
  });

  it("rejects rules that need non-price data, and waits until data exists", async () => {
    const { svc } = make(null, "2026-10-20");
    await expect(
      svc.validate(
        {
          entry: [
            { a: { ind: "eps_surprise" }, op: ">", b: { ind: "num", v: 5 } },
          ],
          exit: [],
        },
        "d",
        {},
      ),
    ).rejects.toThrow(/earnings-surprise/);
    const empty = make(null, null).svc;
    await expect(empty.validate(spec, "d", {})).rejects.toThrow(
      /still being prepared/,
    );
  });
});
