import { isBarsDocFresh, lastBoundary } from "./bars-freshness";

/**
 * 24 Nov 2026 (EST, UTC-5). Stored daily chart docs were served for 20 h whatever
 * session they caught: NVDA's was saved at 09:20 ET Monday (before the open, so no
 * Monday candle) and AAPL's at 11:35 ET (a half-finished candle, close 348.37
 * against the official 349.08), both still "fresh" at 05:14 ET Tuesday.
 */
const at = (iso: string) => Date.parse(iso);
const D = true; // daily doc
const I = false; // intraday doc

describe("lastBoundary", () => {
  const open = [9 * 60 + 30];
  it("is today's open once it has passed on a weekday", () => {
    expect(lastBoundary(at("2026-11-24T10:00:00-05:00"), open)).toBe(at("2026-11-24T09:30:00-05:00"));
  });
  it("is the previous weekday's before the open", () => {
    expect(lastBoundary(at("2026-11-24T05:14:00-05:00"), open)).toBe(at("2026-11-23T09:30:00-05:00"));
  });
  it("skips the weekend back to Friday", () => {
    expect(lastBoundary(at("2026-11-22T12:00:00-05:00"), open)).toBe(at("2026-11-20T09:30:00-05:00"));
    expect(lastBoundary(at("2026-11-21T12:00:00-05:00"), open)).toBe(at("2026-11-20T09:30:00-05:00"));
  });
  it("picks the latest of several boundaries in a day", () => {
    const both = [9 * 60 + 30, 16 * 60 + 30];
    expect(lastBoundary(at("2026-11-23T12:00:00-05:00"), both)).toBe(at("2026-11-23T09:30:00-05:00"));
    expect(lastBoundary(at("2026-11-23T17:00:00-05:00"), both)).toBe(at("2026-11-23T16:30:00-05:00"));
  });
  it("keeps working across the daylight-saving change (Eastern is UTC-4 in summer)", () => {
    expect(lastBoundary(at("2026-07-15T10:00:00-04:00"), open)).toBe(at("2026-07-15T09:30:00-04:00"));
  });
});

describe("isBarsDocFresh: daily candles", () => {
  const now = at("2026-11-24T05:14:00-05:00"); // Tuesday, pre-market

  it("NVDA's doc saved at 09:20 ET Monday (before the open, no Monday candle) is stale", () => {
    expect(isBarsDocFresh("2026-11-23T09:20:23-05:00", D, now)).toBe(false);
  });
  it("AAPL's doc saved at 11:35 ET Monday (half-finished candle) is stale after the close", () => {
    expect(isBarsDocFresh("2026-11-23T11:35:03-05:00", D, now)).toBe(false);
  });
  it("a doc saved after Monday's settled close is fresh the next morning", () => {
    expect(isBarsDocFresh("2026-11-23T16:45:00-05:00", D, now)).toBe(true);
    expect(isBarsDocFresh("2026-11-24T05:00:00-05:00", D, now)).toBe(true);
  });
  it("a doc saved right after the 16:00 close but before it settles (16:10) is still stale", () => {
    expect(isBarsDocFresh("2026-11-23T16:10:00-05:00", D, now)).toBe(false);
  });

  it("at the open, a doc saved before 09:30 no longer counts: today's candle is missing", () => {
    const open10 = at("2026-11-24T10:00:00-05:00");
    expect(isBarsDocFresh("2026-11-24T05:00:00-05:00", D, open10)).toBe(false);
    expect(isBarsDocFresh("2026-11-24T09:45:00-05:00", D, open10)).toBe(true);
  });
  it("during the session a doc saved after the open stays fresh (the live price covers the candle)", () => {
    expect(isBarsDocFresh("2026-11-24T09:45:00-05:00", D, at("2026-11-24T16:10:00-05:00"))).toBe(true);
  });
  it("the same doc goes stale once the close settles, so the final candle is fetched", () => {
    expect(isBarsDocFresh("2026-11-24T09:45:00-05:00", D, at("2026-11-24T16:35:00-05:00"))).toBe(false);
  });

  it("over the weekend, a doc saved after Friday's settled close is fresh (inside the 20 h age cap)", () => {
    const sat = at("2026-11-21T12:00:00-05:00");
    expect(isBarsDocFresh("2026-11-20T17:00:00-05:00", D, sat)).toBe(true);
    expect(isBarsDocFresh("2026-11-20T15:00:00-05:00", D, sat)).toBe(false);
  });
  it("still honours the 20 h age cap", () => {
    expect(isBarsDocFresh("2026-11-20T17:00:00-05:00", D, at("2026-11-21T14:00:00-05:00"))).toBe(false);
  });
  it("rejects a missing, unparseable or future createdAt", () => {
    expect(isBarsDocFresh(undefined, D, now)).toBe(false);
    expect(isBarsDocFresh("not a date", D, now)).toBe(false);
    expect(isBarsDocFresh("2026-11-24T06:00:00-05:00", D, now)).toBe(false);
  });
});

describe("isBarsDocFresh: intraday bars (they include pre- and after-hours)", () => {
  it("during extended hours: 15 minutes, as before", () => {
    const now = at("2026-11-24T05:14:00-05:00");
    expect(isBarsDocFresh("2026-11-24T05:05:00-05:00", I, now)).toBe(true);
    expect(isBarsDocFresh("2026-11-24T04:50:00-05:00", I, now)).toBe(false);
  });
  it("overnight: a doc saved mid-session (AAPL_5min saved 15:06 ET, last bar 14:50) is stale, so the last hour is fetched", () => {
    const night = at("2026-11-23T21:00:00-05:00");
    expect(isBarsDocFresh("2026-11-23T15:06:42-05:00", I, night)).toBe(false);
  });
  it("overnight: a doc saved after the extended session settled stays fresh until the next session", () => {
    expect(isBarsDocFresh("2026-11-23T20:45:00-05:00", I, at("2026-11-24T02:00:00-05:00"))).toBe(true);
  });
  it("weekend: a doc saved after Friday's settle is fresh, one saved before it is not", () => {
    const sat = at("2026-11-21T07:00:00-05:00");
    expect(isBarsDocFresh("2026-11-20T20:45:00-05:00", I, sat)).toBe(true);
    expect(isBarsDocFresh("2026-11-20T18:00:00-05:00", I, sat)).toBe(false);
  });
});
