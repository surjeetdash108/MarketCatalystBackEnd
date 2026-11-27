import { fetchYtdBase, ytdFields, type YtdAggBar, type YtdBarSource } from "./ytd-base.util";

// A daily aggregate dated like Polygon's: the start of the session's ET day.
const bar = (isoDate: string, c: number | null): YtdAggBar => ({
  t: Date.parse(`${isoDate}T05:00:00Z`),
  c,
});

// A source that answers by the range asked for, recording each call.
function source(history: YtdAggBar[], calls: Array<[string, string]> = []): YtdBarSource {
  return {
    async getAggsRange(_ticker, from, to) {
      calls.push([from, to]);
      const inRange = (b: YtdAggBar) => {
        const d = new Date(b.t).toISOString().slice(0, 10);
        return d >= from && d <= to;
      };
      return history.filter(inRange);
    },
  };
}

const NOV_27_2026 = Date.parse("2026-11-27T15:00:00Z");

describe("fetchYtdBase", () => {
  it("is the last close on or before 31 Dec of the prior year, not a later one", async () => {
    const hist = [bar("2025-12-29", 100), bar("2025-12-30", 101), bar("2025-12-31", 102), bar("2026-01-02", 130)];
    const r = await fetchYtdBase(source(hist), "AAA", NOV_27_2026);
    expect(r).toEqual({ close: 102, since: null, year: 2026, failed: false });
  });

  it("falls back to an earlier December close when 31 Dec had no session", async () => {
    const hist = [bar("2025-12-22", 90), bar("2025-12-30", 95)];
    const r = await fetchYtdBase(source(hist), "AAA", NOV_27_2026);
    expect(r.close).toBe(95);
    expect(r.since).toBeNull();
  });

  it("a stock listed this year is measured from its first close, and says which day", async () => {
    const calls: Array<[string, string]> = [];
    const hist = [bar("2026-03-11", 20), bar("2026-03-12", 25), bar("2026-09-01", 30)];
    const r = await fetchYtdBase(source(hist, calls), "NEW", NOV_27_2026);
    expect(r).toEqual({ close: 20, since: "2026-03-11", year: 2026, failed: false });
    // The December window first, then this year.
    expect(calls).toEqual([["2025-12-15", "2025-12-31"], ["2026-01-01", "2026-11-27"]]);
  });

  it("a stock with no bars at all is null, and not marked as a failure", async () => {
    const r = await fetchYtdBase(source([]), "NONE", NOV_27_2026);
    expect(r).toEqual({ close: null, since: null, year: 2026, failed: false });
  });

  it("ignores zero and missing closes", async () => {
    const hist = [bar("2025-12-30", 100), bar("2025-12-31", 0), bar("2025-12-31", null)];
    const r = await fetchYtdBase(source(hist), "AAA", NOV_27_2026);
    expect(r.close).toBe(100);
  });

  it("a vendor error is a failure with no base, never a base of its own", async () => {
    const boom: YtdBarSource = { getAggsRange: () => Promise.reject(new Error("429")) };
    const r = await fetchYtdBase(boom, "AAA", NOV_27_2026);
    expect(r.close).toBeNull();
    expect(r.failed).toBe(true);
  });

  it("takes the year from the ET date: 3am UTC on 1 Jan is still 31 Dec in New York", async () => {
    const r = await fetchYtdBase(source([bar("2024-12-31", 50)]), "AAA", Date.parse("2026-01-01T03:00:00Z"));
    expect(r.year).toBe(2025);
    expect(r.close).toBe(50);
  });
});

describe("ytdFields", () => {
  it("is the three fields the job merges onto the company doc, the base rounded to 4 places", () => {
    expect(ytdFields({ close: 102.123456, since: null, year: 2026, failed: false })).toEqual({
      ytdBaseClose: 102.1235,
      ytdSince: null,
      ytdYear: 2026,
    });
    expect(ytdFields({ close: 20, since: "2026-03-11", year: 2026, failed: false })?.ytdSince).toBe("2026-03-11");
  });

  it("is nothing when no base was found, so a vendor hiccup keeps last night's value", () => {
    expect(ytdFields({ close: null, since: null, year: 2026, failed: true })).toBeNull();
    expect(ytdFields({ close: null, since: null, year: 2026, failed: false })).toBeNull();
  });
});
