import { OnDemandService, BARS_INTERVALS } from "./ondemand.service";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";
import type {
  PolygonService,
  PolygonAggBar,
} from "../vendors/polygon/polygon.service";

const DAY = 86_400_000;

/** 30-minute bars over the full extended session (04:00–20:00 ET) for `days` weekdays ending today. */
function extended30(days: number): PolygonAggBar[] {
  const out: PolygonAggBar[] = [];
  const now = new Date();
  for (let d = days * 2; d >= 1 && out.length < days * 32; d--) {
    const day = new Date(now.getTime() - d * DAY);
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const date = day.toISOString().slice(0, 10);
    // 04:00 ET is 08:00 UTC in EDT; good enough for a fixture — the grouping
    // itself is DST-tested in bars-aggregate.util.spec.ts.
    const start = Date.parse(`${date}T08:00:00Z`);
    for (let i = 0; i < 32; i++) {
      out.push({
        t: start + i * 1_800_000,
        o: 100,
        h: 101,
        l: 99,
        c: 100.5,
        v: 1_000,
        vw: 100.2,
      } as PolygonAggBar);
    }
  }
  return out;
}

function harness(vendorBars: PolygonAggBar[]) {
  const store = new Map<string, unknown>();
  const firebase = {
    firestore: {
      collection: () => ({
        doc: (key: string) => ({
          get: () =>
            Promise.resolve({
              exists: store.has(key),
              data: () => store.get(key),
            }),
          set: (v: unknown) => {
            store.set(key, v);
            return Promise.resolve();
          },
        }),
      }),
    },
  } as unknown as FirebaseAdminService;
  const getAggsRange = jest.fn(() => Promise.resolve(vendorBars));
  const polygon = { getAggsRange } as unknown as PolygonService;
  const svc = new OnDemandService(
    firebase,
    polygon,
    null as never, // snapshots
    null as never, // news
    null, // newsFmp
    null, // estimates
    null as never, // financials
    null as never, // fmp
    null as never, // secEdgar
    null as never, // delisted — only the company paths consult it
    null as never, // monthlyBeta — not under test here
  );
  // Usage counters flush to Firestore on a timer — not under test here.
  jest.spyOn(svc, "recordUsage").mockImplementation(() => undefined);
  return { svc, store, getAggsRange };
}

describe("OnDemandService.getBarsByInterval", () => {
  it("builds 4H candles from the 30-minute doc, widened to 250 days", async () => {
    const { svc, store, getAggsRange } = harness(extended30(10));
    const res = await svc.getBarsByInterval("NVDA", "4H");

    expect(getAggsRange).toHaveBeenCalledTimes(1);
    const [ticker, from, to, timespan, multiplier] = getAggsRange.mock
      .calls[0] as unknown as [string, string, string, string, number];
    expect([ticker, timespan, multiplier]).toEqual(["NVDA", "minute", 30]);
    expect((Date.parse(to) - Date.parse(from)) / DAY).toBe(250);

    expect(store.has("NVDA_30min")).toBe(true);
    expect(res.interval).toBe("4H");
    expect(res.source).toBe("vendor");
    // 10 sessions × 2 regular-session 4H buckets; extended hours dropped
    expect(res.bars).toHaveLength(20);
    expect(res.bars[0].v).toBe(8_000);
    expect(res.bars[1].v).toBe(5_000);
  });

  it("serves a repeat from memory, re-using the grouped array", async () => {
    const { svc, getAggsRange } = harness(extended30(5));
    const first = await svc.getBarsByInterval("NVDA", "1H");
    const again = await svc.getBarsByInterval("NVDA", "1H");
    expect(getAggsRange).toHaveBeenCalledTimes(1);
    expect(again.source).toBe("memory");
    expect(again.bars).toBe(first.bars);
  });

  it("serves the narrower `tf=1M` range from the doc a 4H request widened", async () => {
    const { svc, getAggsRange } = harness(extended30(10));
    await svc.getBarsByInterval("NVDA", "4H");
    const tf = await svc.getBars("NVDA", "1M");
    expect(getAggsRange).toHaveBeenCalledTimes(1);
    expect(tf.source).toBe("memory");
    // the range path returns raw stored bars, extended hours included, cut by
    // TIME (one calendar month) — the 10-weekday fixture fits inside it whole.
    expect(tf.bars).toHaveLength(10 * 32);
  });

  it.each([
    ["1m", "NVDA_1min", "minute", 1],
    ["5m", "NVDA_5min", "minute", 5],
    ["15m", "NVDA_15min", "minute", 15],
    ["30m", "NVDA_30min", "minute", 30],
    ["1D", "NVDA_daily", "day", 1],
    ["1W", "NVDA_daily", "day", 1],
    ["1M", "NVDA_daily", "day", 1],
  ] as const)(
    "%s reads %s (%s × %d)",
    async (interval, key, timespan, multiplier) => {
      const { svc, store, getAggsRange } = harness(extended30(2));
      await svc.getBarsByInterval("NVDA", interval);
      expect(store.has(key)).toBe(true);
      const call = getAggsRange.mock.calls[0] as unknown as unknown[];
      expect(call[3]).toBe(timespan);
      expect(call[4]).toBe(multiplier);
    },
  );

  it("validates intervals case-sensitively", () => {
    const { svc } = harness([]);
    expect(BARS_INTERVALS.every((i) => svc.isValidInterval(i))).toBe(true);
    expect(svc.isValidInterval("1h")).toBe(false);
    expect(svc.isValidInterval("3M")).toBe(false);
    expect(svc.isValidInterval("")).toBe(false);
  });
});

describe("stock_bars incremental refresh stays bounded", () => {
  it("a stale 1-minute doc holding 30 days is trimmed back to its 5-day window on refresh", async () => {
    const now = Date.now();
    const old = Array.from({ length: 30 * 24 }, (_, i) => ({ t: now - (30 * DAY) + i * 3_600_000, o: 1, h: 1, l: 1, c: 1, v: 1, vw: 1 }));
    const tail = old[old.length - 1].t;
    const { svc, store } = harness([{ t: tail, o: 2, h: 2, l: 2, c: 2, v: 2, vw: 2 } as PolygonAggBar]);
    store.set("NVDA_1min", { ticker: "NVDA", resolution: "1min", bars: old, rangeDays: 5, barCount: old.length, createdAt: new Date(now - 2 * DAY).toISOString(), updatedAt: "", source: "polygon-ondemand" });
    await svc.getBars("NVDA", "1H");
    const saved = store.get("NVDA_1min") as { bars: Array<{ t: number }>; barCount: number };
    expect(Math.min(...saved.bars.map((b) => b.t))).toBeGreaterThanOrEqual(now - 6 * DAY - 60_000);
    expect(saved.barCount).toBe(saved.bars.length);
    expect(saved.bars.length).toBeLessThan(old.length / 4);
  });
});


describe("stock_bars incremental refresh takes the vendor's revisions of the current session", () => {
  // Errors 18–20 (FCX/SCCO/B): the stored 09:30 5-minute bar kept the high the
  // delayed feed first reported (= the official open, $52.18) after Polygon
  // revised it to $52.63; only the last stored bar was ever replaced.
  it("every bar from the last stored bar's day is replaced, not only the tail", async () => {
    // A fixed session (Nov 18, 09:30–12:30 ET) so the bars are regular-session
    // bars whatever time the suite runs.
    jest.useFakeTimers({ now: Date.parse("2026-11-18T18:00:00Z"), doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval"] });
    const now = Date.now();
    const start = Date.parse("2026-11-18T14:30:00Z");
    const stored = Array.from({ length: 36 }, (_, i) => ({ t: start + i * 300_000, o: 52.18, h: 52.18, l: 51.45, c: 51.46, v: 10, vw: 51.8 }));
    const revised = stored.map((b, i) => (i === 0 ? { ...b, h: 52.63, l: 51.44, c: 51.45 } : b)) as PolygonAggBar[];
    const { svc, store } = harness(revised);
    store.set("FCX_5min", { ticker: "FCX", resolution: "5min", bars: stored, rangeDays: 9, barCount: stored.length, createdAt: new Date(now - 2 * DAY).toISOString(), updatedAt: "", source: "polygon-ondemand" });
    const res = await svc.getBarsByInterval("FCX", "5m");
    const saved = store.get("FCX_5min") as { bars: Array<{ t: number; h: number }> };
    expect(saved.bars.find((b) => b.t === start)?.h).toBe(52.63);
    expect(saved.bars).toHaveLength(stored.length);
    expect(Math.max(...res.bars.map((b) => b.h))).toBe(52.63);
    jest.useRealTimers();
  });

  it("an empty vendor answer keeps what's stored", async () => {
    const now = Date.now();
    const stored = Array.from({ length: 6 }, (_, i) => ({ t: now - 3_600_000 + i * 300_000, o: 1, h: 2, l: 1, c: 1.5, v: 1, vw: 1 }));
    const { svc, store } = harness([]);
    store.set("FCX_5min", { ticker: "FCX", resolution: "5min", bars: stored, rangeDays: 9, barCount: stored.length, createdAt: new Date(now - 2 * DAY).toISOString(), updatedAt: "", source: "polygon-ondemand" });
    await svc.getBarsByInterval("FCX", "5m");
    expect((store.get("FCX_5min") as { bars: unknown[] }).bars).toHaveLength(6);
  });
});

describe("stock_bars refresh also heals the last week's frozen bars", () => {
  // Nov 19 workbook row 13 (MDRN): the stored Nov 13 first bar kept high 6.00
  // (the open) from before the session-revision fix; Polygon's bar reads 6.25.
  it("a bar revised by the vendor 4 days before the tail is replaced", async () => {
    jest.useFakeTimers({ now: Date.parse("2026-11-19T16:00:00Z"), doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval"] });
    const nov13 = Date.parse("2026-11-13T14:30:00Z");
    const nov19 = Date.parse("2026-11-19T14:30:00Z");
    const stored = [
      { t: nov13, o: 6, h: 6, l: 5.57, c: 5.73, v: 1, vw: 5.8 },
      { t: nov13 + 300_000, o: 5.73, h: 5.9, l: 5.5, c: 5.6, v: 1, vw: 5.7 },
      { t: nov19, o: 1.98, h: 2.0, l: 1.95, c: 1.99, v: 1, vw: 1.98 },
    ];
    const vendor = [{ ...stored[0], h: 6.25 }, stored[1], stored[2], { t: nov19 + 300_000, o: 1.99, h: 2.09, l: 1.98, c: 2.05, v: 1, vw: 2.0 }] as PolygonAggBar[];
    const { svc, store, getAggsRange } = harness(vendor);
    store.set("MDRN_5min", { ticker: "MDRN", resolution: "5min", bars: stored, rangeDays: 9, barCount: stored.length, createdAt: new Date(Date.now() - 2 * DAY).toISOString(), updatedAt: "", source: "polygon-ondemand" });
    await svc.getBarsByInterval("MDRN", "5m");
    const saved = store.get("MDRN_5min") as { bars: Array<{ t: number; h: number }> };
    expect(saved.bars.find((b) => b.t === nov13)?.h).toBe(6.25);
    expect(saved.bars).toHaveLength(4);
    expect((getAggsRange.mock.calls[0] as unknown[])[1]).toBe("2026-11-12");
    jest.useRealTimers();
  });
});
