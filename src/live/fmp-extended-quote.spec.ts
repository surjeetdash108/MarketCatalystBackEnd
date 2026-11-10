import { fmpSession, mapFmpQuote } from "./snapshot-cache.service";
import type {
  FmpExtendedTrade,
  FmpFullQuote,
} from "../vendors/fmp/fmp.service";

/**
 * FMP's quote is regular-session only. These pin the extended-hours overlay to
 * Polygon's field semantics, using AAPL's real 13–14 Oct 2026 figures: close
 * 341.27 on 13 Oct (prev 340.97), after-hours 340.37, pre-market 344.475.
 */

const et = (iso: string) => Date.parse(iso); // ISO strings below carry the ET offset
const secs = (iso: string) => Math.floor(et(iso) / 1000);

const quote = (over: Partial<FmpFullQuote> = {}): FmpFullQuote => ({
  symbol: "AAPL",
  price: 341.27,
  change: 0.3,
  changePercentage: 0.088,
  previousClose: 340.97,
  open: 340,
  dayHigh: 342,
  dayLow: 339,
  volume: 1_000_000,
  // The 13 Oct regular close print.
  timestamp: secs("2026-10-13T16:00:01-04:00"),
  ...over,
});
const trade = (price: number, iso: string): FmpExtendedTrade => ({
  symbol: "AAPL",
  price,
  at: et(iso),
});

describe("mapFmpQuote", () => {
  it("pre-market: prices today's trade off the last close", () => {
    const q = mapFmpQuote(
      quote(),
      trade(344.475, "2026-10-14T08:57:52-04:00"),
      et("2026-10-14T08:58:00-04:00"),
    );
    expect(q.marketStatus).toBe("early_trading");
    expect(q.price).toBe(344.475);
    expect(q.previousClose).toBe(341.27);
    expect(q.regularClose).toBe(341.27);
    expect(q.change).toBeCloseTo(3.205, 3);
    expect(q.changePct).toBeCloseTo(0.939, 3);
    expect(q.earlyTradingChangePct).toBeCloseTo(0.939, 3);
    expect(q.regularTradingChangePct).toBeNull();
    expect(q.lateTradingChangePct).toBeNull();
  });

  it("pre-market before any trade: never passes last evening's print off as pre-market", () => {
    const q = mapFmpQuote(
      quote(),
      trade(340.37, "2026-10-13T19:59:00-04:00"),
      et("2026-10-14T04:30:00-04:00"),
    );
    expect(q.marketStatus).toBe("early_trading");
    expect(q.price).toBe(341.27);
    expect(q.change).toBe(0);
    expect(q.earlyTradingChangePct).toBeNull();
  });

  it("after hours: day move from the closes, after-hours move on its own", () => {
    const q = mapFmpQuote(
      quote(),
      trade(340.37, "2026-10-13T19:30:00-04:00"),
      et("2026-10-13T19:31:00-04:00"),
    );
    expect(q.marketStatus).toBe("late_trading");
    expect(q.price).toBe(340.37);
    expect(q.regularClose).toBe(341.27);
    expect(q.previousClose).toBe(340.97);
    expect(q.change).toBeCloseTo(-0.6, 6);
    expect(q.changePct).toBeCloseTo(-0.176, 3);
    expect(q.lateTradingChangePct).toBeCloseTo(-0.264, 3);
    expect(q.regularTradingChangePct).toBe(0.088);
  });

  it("overnight keeps the last after-hours trade, as Polygon does", () => {
    const q = mapFmpQuote(
      quote(),
      trade(340.37, "2026-10-13T19:59:00-04:00"),
      et("2026-10-14T02:00:00-04:00"),
    );
    expect(q.marketStatus).toBe("closed");
    expect(q.price).toBe(340.37);
    expect(q.regularClose).toBe(341.27);
  });

  it("after hours with no trade since the close shows the close", () => {
    const q = mapFmpQuote(
      quote(),
      trade(339.9, "2026-10-13T15:59:00-04:00"),
      et("2026-10-13T17:00:00-04:00"),
    );
    expect(q.price).toBe(341.27);
    expect(q.changePct).toBe(0.088);
    expect(q.lateTradingChangePct).toBeNull();
  });

  it("regular hours: the quote as-is, now with a session so the UI stops tagging it EXT", () => {
    const q = mapFmpQuote(
      quote({
        price: 343,
        changePercentage: 0.5,
        timestamp: secs("2026-10-14T11:00:00-04:00"),
      }),
      undefined,
      et("2026-10-14T11:00:05-04:00"),
    );
    expect(q.marketStatus).toBe("open");
    expect(q.price).toBe(343);
    expect(q.regularTradingChangePct).toBe(0.5);
  });
});

describe("fmpSession", () => {
  it("a holiday is never 'open' — no print today", () => {
    expect(
      fmpSession(
        quote({ timestamp: secs("2026-11-25T16:00:01-05:00") }),
        et("2026-11-26T11:00:00-05:00"),
      ),
    ).toBe("closed");
  });

  it("weekends are closed", () => {
    expect(fmpSession(quote(), et("2026-10-17T10:00:00-04:00"))).toBe("closed");
  });
});
