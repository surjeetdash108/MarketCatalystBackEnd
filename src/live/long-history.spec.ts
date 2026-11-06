import { etMidnightMs, fetchOlderDaily, prependOlder, LONG_HISTORY_PAGE } from "./long-history";

/** FMP answers newest-first, at most LONG_HISTORY_PAGE rows, for symbol/from/to. */
function fakeFmp(rows: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>) {
  const calls: string[] = [];
  const request = async (path: string) => {
    calls.push(path);
    const to = /to=(\d{4}-\d{2}-\d{2})/.exec(path)![1];
    return rows.filter((r) => r.date <= to).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, LONG_HISTORY_PAGE);
  };
  return { request, calls };
}
const day = (i: number) => new Date(Date.UTC(1980, 11, 12) + i * 86_400_000).toISOString().slice(0, 10);

describe("full price history before the 5-year window", () => {
  it("stamps a day at ET midnight (same as Polygon daily aggs), across DST", () => {
    expect(etMidnightMs("2025-10-02")).toBe(Date.UTC(2025, 9, 2, 4)); // EDT
    expect(etMidnightMs("2025-12-02")).toBe(Date.UTC(2025, 11, 2, 5)); // EST
  });

  it("pages backwards past FMP's per-call cap until the listing date", async () => {
    const rows = Array.from({ length: 12_000 }, (_, i) => ({ date: day(i), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }));
    const fmp = fakeFmp(rows);
    const out = await fetchOlderDaily(fmp.request, "AAPL", day(11_000));
    expect(out.length).toBe(11_000); // every day strictly before the cut-off
    expect(out[0].t).toBe(etMidnightMs(day(0)));
    expect(out[out.length - 1].t).toBe(etMidnightMs(day(10_999)));
    expect(fmp.calls.length).toBe(3); // 5000 + 5000 + 1000
    expect(fmp.calls[0]).toContain("historical-price-eod/full?symbol=AAPL&from=");
    for (let i = 1; i < out.length; i++) expect(out[i].t).toBeGreaterThan(out[i - 1].t);
  });

  it("a stock listed inside the window has nothing older; FMP failure → nothing older (the 5 years still serve)", async () => {
    expect(await fetchOlderDaily(fakeFmp([]).request, "NEWCO", "2024-01-02")).toEqual([]);
    expect(await fetchOlderDaily(async () => { throw new Error("502"); }, "AAPL", "2024-01-02")).toEqual([]);
  });

  it("prepends only bars before the first stored one — no overlap, no duplicates", () => {
    const recent = [{ t: 300, o: 1, h: 1, l: 1, c: 1, v: 1, vw: 1 }, { t: 400, o: 1, h: 1, l: 1, c: 1, v: 1, vw: 1 }];
    const older = [100, 200, 300].map((t) => ({ t, o: 2, h: 2, l: 2, c: 2, v: 2, vw: null }));
    expect(prependOlder(older, recent).map((b) => b.t)).toEqual([100, 200, 300, 400]);
    expect(prependOlder(older, recent)[2].o).toBe(1); // the stored bar wins
    expect(prependOlder([], recent)).toBe(recent);
  });
});
