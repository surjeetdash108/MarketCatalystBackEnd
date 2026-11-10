import { splitMovers } from "./movers-split.util";

type Row = { ticker: string; pctChange: number | null };
const pct = (r: Row) => r.pctChange;

describe("splitMovers", () => {
  it("ranks gainers desc and losers asc", () => {
    const rows: Row[] = [
      { ticker: "A", pctChange: 2 },
      { ticker: "B", pctChange: -5 },
      { ticker: "C", pctChange: 9 },
      { ticker: "D", pctChange: -1 },
    ];
    const { gainers, losers } = splitMovers(rows, pct, 10);
    expect(gainers.map((r) => r.ticker)).toEqual(["C", "A"]);
    expect(losers.map((r) => r.ticker)).toEqual(["B", "D"]);
  });

  it("never puts a ticker on both lists when the pool is smaller than topN", () => {
    const rows: Row[] = [
      { ticker: "A", pctChange: 3 },
      { ticker: "B", pctChange: -2 },
      { ticker: "C", pctChange: 1 },
    ];
    const { gainers, losers } = splitMovers(rows, pct, 100);
    const overlap = gainers.filter((g) => losers.includes(g));
    expect(overlap).toEqual([]);
  });

  it("returns empty lists (not mirrored ones) when every move ties at 0", () => {
    const rows: Row[] = [
      { ticker: "A", pctChange: 0 },
      { ticker: "B", pctChange: 0 },
    ];
    expect(splitMovers(rows, pct, 10)).toEqual({ gainers: [], losers: [] });
  });

  it("drops null / non-finite changes and respects topN", () => {
    const rows: Row[] = [
      { ticker: "A", pctChange: null },
      { ticker: "B", pctChange: NaN },
      { ticker: "C", pctChange: 4 },
      { ticker: "D", pctChange: 6 },
    ];
    const { gainers, losers } = splitMovers(rows, pct, 1);
    expect(gainers.map((r) => r.ticker)).toEqual(["D"]);
    expect(losers).toEqual([]);
  });
});
