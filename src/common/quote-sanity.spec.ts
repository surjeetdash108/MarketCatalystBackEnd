import { quoteRefFromPolygon, sanitizeQuote } from "./quote-sanity";

const ns = (iso: string) => Date.parse(iso) * 1e6;
const NOW = Date.parse("2026-11-19T15:58:00Z"); // 10:58 ET, Nov 19
const OPEN = Date.parse("2026-11-19T14:30:00Z");

describe("quote reference from Polygon's snapshot", () => {
  it("previous close comes from the official map, never the snapshot's stale previous_close", () => {
    const r = quoteRefFromPolygon(
      {
        ticker: "BRK.B",
        session: {
          previous_close: 586.76,
          low: 567.1,
          high: 573.13,
          price: 568.21,
        },
        last_minute: { last_updated: ns("2026-11-19T15:57:00Z") },
      },
      574.62,
      OPEN,
    );
    expect(r.prevClose).toBe(574.62);
    expect(r.tradedToday).toBe(true);
  });
  it("a last minute from yesterday means no regular trade today; OTC is flagged", () => {
    const r = quoteRefFromPolygon(
      {
        ticker: "AAPG",
        session: { low: 12.96, high: 13.05, price: 13.0129 },
        last_minute: { last_updated: ns("2026-11-18T20:08:00Z"), otc: false },
      },
      13.0129,
      OPEN,
    );
    expect(r.tradedToday).toBe(false);
    expect(
      quoteRefFromPolygon(
        {
          ticker: "TCGLF",
          session: {},
          last_minute: { last_updated: ns("2026-11-19T15:26:00Z"), otc: true },
        },
        30.05,
        OPEN,
      ).otc,
    ).toBe(true);
  });
});

describe("sanitizeQuote (Nov 19 workbook rows 1, 2, 11, 12)", () => {
  it("BRK.B: % from the official previous close (−1.01%), not the close two sessions back (−3.07%)", () => {
    const out = sanitizeQuote(
      { price: 568.8, previousClose: 586.76, dayLow: 567.93, dayHigh: 573.13 },
      {
        prevClose: 574.62,
        tradedToday: true,
        sessionLow: 567.1,
        sessionHigh: 573.13,
        sessionPrice: 568.8,
        lastMinuteAt: NOW - 60_000,
        otc: false,
      },
      NOW,
      OPEN,
    );
    expect(out.previousClose).toBe(574.62);
    expect(out.changePct).toBeCloseTo(-1.01, 2);
  });
  it("AAPG: no regular trade today → the previous close, 0%, no day range (no new 52-week low)", () => {
    const out = sanitizeQuote(
      { price: 12.715, previousClose: 13.01, dayLow: 12.54, dayHigh: 12.92 },
      {
        prevClose: 13.0129,
        tradedToday: false,
        sessionLow: null,
        sessionHigh: null,
        sessionPrice: null,
        lastMinuteAt: null,
        otc: false,
      },
      NOW,
      OPEN,
    );
    expect(out).toMatchObject({
      price: 13.0129,
      changePct: 0,
      dayLow: null,
      dayHigh: null,
      adjusted: "no-trade-today",
    });
  });
  it("a print outside the regular range (TCGLF $7.47 on a $30 tape) → the regular-session price", () => {
    const out = sanitizeQuote(
      { price: 7.47, previousClose: 30, dayLow: 7.47, dayHigh: 30.05 },
      {
        prevClose: 30.05,
        tradedToday: true,
        sessionLow: 30.02,
        sessionHigh: 30.05,
        sessionPrice: 30.02,
        lastMinuteAt: NOW - 120_000,
        otc: true,
      },
      NOW,
      OPEN,
    );
    expect(out.price).toBe(30.02);
    expect(out.dayLow).toBe(30.02);
    expect(out.changePct).toBeCloseTo(-0.1, 1);
    expect(out.adjusted).toBe("outside-session-range");
  });
  it("YXT: a quote frozen at the session low while the tape moved on → the latest regular-session price", () => {
    const out = sanitizeQuote(
      {
        price: 0.831,
        previousClose: 0.91,
        dayLow: 0.831,
        dayHigh: 0.95,
        vendorAt: NOW - 9 * 60_000,
      },
      {
        prevClose: 0.8885,
        tradedToday: true,
        sessionLow: 0.831,
        sessionHigh: 0.95,
        sessionPrice: 0.922,
        lastMinuteAt: NOW - 60_000,
        otc: false,
      },
      NOW,
      OPEN,
    );
    expect(out.price).toBe(0.922);
    expect(out.changePct).toBeCloseTo((0.922 / 0.8885 - 1) * 100, 6);
    expect(out.adjusted).toBe("stale-quote");
  });
  it("the day range is the regular session's (an odd-lot low can't make a new 52-week low)", () => {
    const out = sanitizeQuote(
      {
        price: 50.2,
        previousClose: 50,
        dayLow: 44.1,
        dayHigh: 51,
        vendorAt: NOW - 5_000,
      },
      {
        prevClose: 50,
        tradedToday: true,
        sessionLow: 49.8,
        sessionHigh: 51,
        sessionPrice: 50.2,
        lastMinuteAt: NOW - 60_000,
        otc: false,
      },
      NOW,
      OPEN,
    );
    expect([out.price, out.dayLow, out.dayHigh, out.adjusted]).toEqual([
      50.2,
      49.8,
      51,
      null,
    ]);
  });
  it("a healthy quote is untouched apart from the official base", () => {
    const out = sanitizeQuote(
      {
        price: 349.66,
        previousClose: 352.45,
        dayLow: 347.5,
        dayHigh: 355.28,
        vendorAt: NOW - 5_000,
      },
      {
        prevClose: 352.45,
        tradedToday: true,
        sessionLow: 347.5,
        sessionHigh: 355.28,
        sessionPrice: 349.6,
        lastMinuteAt: NOW - 60_000,
        otc: false,
      },
      NOW,
      OPEN,
    );
    expect(out).toMatchObject({
      price: 349.66,
      dayLow: 347.5,
      dayHigh: 355.28,
      adjusted: null,
    });
  });
  it("before the open nothing is replaced (pre-market prices are legitimate)", () => {
    const pre = Date.parse("2026-11-19T13:00:00Z");
    const out = sanitizeQuote(
      { price: 12.715, previousClose: 13.01, dayLow: null, dayHigh: null },
      {
        prevClose: 13.0129,
        tradedToday: false,
        sessionLow: null,
        sessionHigh: null,
        sessionPrice: null,
        lastMinuteAt: null,
        otc: false,
      },
      pre,
      null,
    );
    expect(out.price).toBe(12.715);
    expect(out.previousClose).toBe(13.0129);
  });
});

describe("QuoteReferenceCache", () => {
  const { QuoteReferenceCache } = jest.requireActual("./quote-sanity");
  it("official previous closes from the last completed session; a missing snapshot row only sets the base", async () => {
    const grouped = jest.fn((d: string) =>
      Promise.resolve(
        d === "2026-11-18"
          ? [...Array(150)]
              .map((_, i) => ({ T: `X${i}`, c: 1 }))
              .concat([
                { T: "BRK.B", c: 574.62 },
                { T: "AAPG", c: 13.0129 },
              ])
          : [],
      ),
    );
    const raw = jest.fn(() =>
      Promise.resolve([
        {
          ticker: "AAPG",
          session: { low: 12.96, high: 13.05, price: 13.0129 },
          last_minute: { last_updated: ns("2026-11-18T20:08:00Z") },
        },
      ]),
    );
    const c = new QuoteReferenceCache(raw, grouped);
    const refs = await c.refs(["BRK.B", "AAPG"], NOW);
    expect(grouped).toHaveBeenCalledWith("2026-11-18");
    expect(refs.get("BRK.B")).toMatchObject({
      prevClose: 574.62,
      tradedToday: true,
      sessionPrice: null,
    });
    expect(refs.get("AAPG")).toMatchObject({
      prevClose: 13.0129,
      tradedToday: false,
    });
    await c.refs(["AAPG"], NOW + 1000);
    expect(raw).toHaveBeenCalledTimes(1); // reused within a minute
    expect(grouped).toHaveBeenCalledTimes(1); // once per session
  });
});
