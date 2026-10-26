import * as fs from "fs";
import * as path from "path";
import { mapFmpQuote } from "./snapshot-cache.service";
import { quoteRow } from "./official-quote.util";

/**
 * Real FMP quotes + after-hours trades fetched after the 2026-10-26 close
 * (PEP official close 135.45, after-hours trade 135.05). Outside regular hours
 * every list surface (header search, quotes) must show the official 4:00 PM
 * close and its day move; the after-hours trade is reported separately, with
 * its time.
 */
describe("quoteRow — official close outside regular hours", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/after-close-quotes.json"), "utf-8"));
  const snap = (sym: string) => {
    const q = fx.quotes.find((x: { symbol: string }) => x.symbol === sym);
    const t = fx.trades.find((x: { symbol: string }) => x.symbol === sym);
    const fq = { ...q, timestamp: q.timestamp, changePercentage: q.changePercentage };
    return mapFmpQuote(fq, t ? { symbol: sym, price: t.price, at: t.timestamp } : undefined, fx.fetchedAtMs);
  };

  it("PEP after the close: official 135.45 / −0.24%, after-hours 135.05 shown separately with its time", () => {
    const row = quoteRow(snap("PEP"));
    expect(row.price).toBe(135.45);
    expect(row.pctChange).toBeCloseTo(-0.2357, 3);
    expect(row.extended).toEqual({ session: "after-hours", price: 135.05, pctChange: expect.any(Number), at: 1793047418000 });
    expect(row.extended!.pctChange).toBeCloseTo((135.05 / 135.45 - 1) * 100, 6);
  });

  it("a ticker with no after-hours move has no extended block", () => {
    const row = quoteRow(snap("KR"));
    expect(row.price).toBe(66.77);
    expect(row.extended).toBeNull();
  });
});
