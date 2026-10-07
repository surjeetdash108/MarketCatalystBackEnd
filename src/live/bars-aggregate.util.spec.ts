import {
  groupCandles,
  groupMonthly,
  groupSession,
  groupWeekly,
  type Candle,
} from "./bars-aggregate.util";

/** Epoch ms for an ET wall-clock time; `off` is the ET UTC offset that day. */
const et = (date: string, time: string, off: "-04:00" | "-05:00" = "-04:00") =>
  Date.parse(`${date}T${time}:00${off}`);

/** A bar whose fields encode its position, so merges are easy to check. */
const bar = (t: number, i: number, over: Partial<Candle> = {}): Candle => ({
  t,
  o: 100 + i,
  h: 110 + i,
  l: 90 + i,
  c: 105 + i,
  v: 1_000,
  vw: 100 + i,
  ...over,
});

/** 30-minute bars across the full extended session, 04:00–19:30 ET. */
function extendedDay30(
  date: string,
  off: "-04:00" | "-05:00" = "-04:00",
): Candle[] {
  const out: Candle[] = [];
  for (let m = 4 * 60; m < 20 * 60; m += 30) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    out.push(bar(et(date, `${hh}:${mm}`, off), out.length));
  }
  return out;
}

const hhmm = (t: number) =>
  new Date(t).toLocaleTimeString("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
  });

describe("groupSession", () => {
  const day = extendedDay30("2026-10-06");

  it("bucket size equal to the bar size is a pure regular-session filter", () => {
    const out = groupSession(day, 30);
    expect(out).toHaveLength(13);
    expect(hhmm(out[0].t)).toBe("09:30");
    expect(hhmm(out[12].t)).toBe("15:30");
    // untouched, field for field
    expect(out[0]).toEqual(day.find((b) => b.t === out[0].t));
  });

  it("builds 1H candles anchored at the open, with a short last bucket", () => {
    const out = groupSession(day, 60);
    expect(out.map((b) => hhmm(b.t))).toEqual([
      "09:30",
      "10:30",
      "11:30",
      "12:30",
      "13:30",
      "14:30",
      "15:30",
    ]);
    // first hour = the 09:30 and 10:00 bars (indexes 11 and 12 of the day)
    expect(out[0]).toEqual({
      t: et("2026-10-06", "09:30"),
      o: 111,
      h: 122,
      l: 101,
      c: 117,
      v: 2_000,
      vw: 111.5,
    });
    // 15:30 has a single 30-minute part
    expect(out[6].v).toBe(1_000);
  });

  it("builds 4H candles 09:30–13:30 and 13:30–16:00", () => {
    const out = groupSession(day, 240);
    expect(out.map((b) => hhmm(b.t))).toEqual(["09:30", "13:30"]);
    expect(out.map((b) => b.v)).toEqual([8_000, 5_000]);
  });

  it("never merges across sessions", () => {
    const two = [
      ...extendedDay30("2026-10-05"),
      ...extendedDay30("2026-10-06"),
    ];
    const out = groupSession(two, 240);
    expect(out).toHaveLength(4);
    expect(
      new Set(out.map((b) => new Date(b.t).toISOString().slice(0, 10))).size,
    ).toBe(2);
  });

  it("keeps the session window on both sides of a DST change", () => {
    const fri = extendedDay30("2026-03-06", "-05:00"); // EST
    const mon = extendedDay30("2026-03-09", "-04:00"); // EDT
    const out = groupSession([...fri, ...mon], 30);
    expect(out).toHaveLength(26);
    expect(out[0].t).toBe(et("2026-03-06", "09:30", "-05:00"));
    expect(out[13].t).toBe(et("2026-03-09", "09:30", "-04:00"));
  });

  it("stamps a bucket with its start even when the first trade is later", () => {
    const thin = [
      bar(et("2026-10-06", "10:41"), 0),
      bar(et("2026-10-06", "11:02"), 1),
    ];
    const out = groupSession(thin, 60);
    expect(out).toHaveLength(1);
    expect(hhmm(out[0].t)).toBe("10:30");
    expect(out[0].o).toBe(100);
    expect(out[0].c).toBe(106);
  });

  it("leaves VWAP null when no part carries one, and ignores parts that don't", () => {
    const t = et("2026-10-06", "09:30");
    const none = groupSession(
      [bar(t, 0, { vw: null }), bar(t + 1_800_000, 1, { vw: null })],
      60,
    );
    expect(none[0].vw).toBeNull();
    const some = groupSession(
      [bar(t, 0, { vw: null }), bar(t + 1_800_000, 1, { vw: 50 })],
      60,
    );
    expect(some[0].vw).toBe(50);
  });

  it("rejects a non-positive bucket", () => {
    expect(() => groupSession(day, 0)).toThrow(RangeError);
  });
});

/** Daily bars are stamped at ET midnight. */
const daily = (dates: string[], off: "-04:00" | "-05:00" = "-04:00") =>
  dates.map((d, i) => bar(et(d, "00:00", off), i));

describe("groupWeekly", () => {
  it("merges Mon–Fri, including a week that straddles a month end", () => {
    const out = groupWeekly(
      daily([
        "2026-09-28",
        "2026-09-29",
        "2026-09-30",
        "2026-10-01",
        "2026-10-02",
        "2026-10-05",
        "2026-10-06",
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      t: et("2026-09-28", "00:00"),
      o: 100,
      c: 109,
      v: 5_000,
    });
    expect(out[1]).toMatchObject({
      t: et("2026-10-05", "00:00"),
      o: 105,
      c: 111,
      v: 2_000,
    });
  });

  it("dates a holiday-Monday week by its first session", () => {
    // 2026-09-07 is Labor Day
    const out = groupWeekly(daily(["2026-09-04", "2026-09-08", "2026-09-09"]));
    expect(out.map((b) => b.t)).toEqual([
      et("2026-09-04", "00:00"),
      et("2026-09-08", "00:00"),
    ]);
  });
});

describe("groupMonthly", () => {
  it("splits on the ET calendar month, across the November DST change", () => {
    const bars = [
      ...daily(["2026-10-29", "2026-10-30"], "-04:00"),
      ...daily(["2026-11-02", "2026-11-03"], "-05:00"),
    ];
    const out = groupMonthly(bars);
    expect(out).toHaveLength(2);
    expect(out[0].t).toBe(et("2026-10-29", "00:00", "-04:00"));
    expect(out[1].t).toBe(et("2026-11-02", "00:00", "-05:00"));
    expect(out.map((b) => b.v)).toEqual([2_000, 2_000]);
  });
});

describe("groupCandles", () => {
  it("returns the input itself for `none`", () => {
    const d = daily(["2026-10-05"]);
    expect(groupCandles(d, { kind: "none" })).toBe(d);
  });

  it("dispatches each grouping", () => {
    const d = extendedDay30("2026-10-06");
    expect(groupCandles(d, { kind: "session", minutes: 120 })).toHaveLength(4);
    expect(
      groupCandles(daily(["2026-10-05", "2026-10-06"]), { kind: "week" }),
    ).toHaveLength(1);
    expect(
      groupCandles(daily(["2026-09-30", "2026-10-01"]), { kind: "month" }),
    ).toHaveLength(2);
  });
});
