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
    null as never,
    null as never,
    null,
    null,
    null as never,
    null as never,
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
    // the range path is unchanged: raw stored bars, extended hours included
    expect(tf.bars).toHaveLength(286);
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
