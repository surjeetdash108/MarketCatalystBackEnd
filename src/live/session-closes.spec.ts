import {
  completedSessionBars,
  DailyClosesCache,
  isRolled,
  lastTwoCloses,
} from "./session-closes";

/** A wall-clock instant given as New York time (EDT, UTC-4, in October). */
const et = (iso: string) => new Date(`${iso}-04:00`);

const bar = (date: string, c: number) => ({
  // Polygon daily bars are stamped at midnight ET of their session.
  t: et(`${date}T00:00:00`).getTime(),
  o: c - 1,
  h: c + 2,
  l: c - 3,
  c,
  v: 1,
  T: "SPY",
});

describe("isRolled", () => {
  it("never flags the regular session", () => {
    expect(isRolled({ value: 100, prevClose: 100, pctChange: 0 }, "open")).toBe(
      false,
    );
  });

  it("never flags when the session is unknown (market-status outage)", () => {
    expect(
      isRolled({ value: 100, prevClose: 100, pctChange: 0 }, "unknown"),
    ).toBe(false);
  });

  it("flags a rolled snapshot off-hours (value sits on the previous close)", () => {
    expect(
      isRolled({ value: 769.64, prevClose: 769.64, pctChange: 0 }, "closed"),
    ).toBe(true);
    expect(
      isRolled({ value: 769.64, prevClose: 769.64, pctChange: 0 }, "pre"),
    ).toBe(true);
  });

  it("keeps a real off-hours move", () => {
    expect(
      isRolled({ value: 769.64, prevClose: 764.02, pctChange: 0.74 }, "after"),
    ).toBe(false);
  });

  it("treats a missing figure as rolled so the caller can rebuild it", () => {
    expect(
      isRolled({ value: null, prevClose: 1, pctChange: 0.1 }, "closed"),
    ).toBe(true);
  });
});

describe("completedSessionBars", () => {
  const bars = [
    bar("2026-10-01", 764.02),
    bar("2026-10-02", 769.64),
    bar("2026-10-05", 772.1),
  ];

  it("drops today's half-formed bar before the session is final", () => {
    const out = completedSessionBars(bars, et("2026-10-05T08:00:00"));
    expect(out.map((b) => b.date)).toEqual(["2026-10-01", "2026-10-02"]);
  });

  it("keeps today's bar once the session is final (evening of the same day)", () => {
    const out = completedSessionBars(bars, et("2026-10-05T21:00:00"));
    expect(out.map((b) => b.date)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-05",
    ]);
  });

  it("drops today's bar during the 15-minute vendor delay after the close", () => {
    const out = completedSessionBars(bars, et("2026-10-05T16:10:00"));
    expect(out.map((b) => b.date).pop()).toBe("2026-10-02");
  });

  it("ignores bars without a finite close", () => {
    const out = completedSessionBars(
      [bar("2026-10-01", NaN), bar("2026-10-02", 769.64)],
      et("2026-10-03T12:00:00"),
    );
    expect(out.map((b) => b.date)).toEqual(["2026-10-02"]);
  });
});

describe("lastTwoCloses", () => {
  it("returns the last two sessions with their real move", () => {
    const pair = lastTwoCloses([
      { date: "2026-10-01", o: 1, h: 1, l: 1, c: 764.02 },
      { date: "2026-10-02", o: 1, h: 1, l: 1, c: 769.64 },
    ]);
    expect(pair?.last.date).toBe("2026-10-02");
    expect(pair?.prev.c).toBe(764.02);
  });

  it("needs two sessions", () => {
    expect(
      lastTwoCloses([{ date: "2026-10-02", o: 1, h: 1, l: 1, c: 769.64 }]),
    ).toBeNull();
  });
});

describe("DailyClosesCache", () => {
  const logger = { warn: jest.fn() };

  it("fetches once per window and refetches once the session turns final", async () => {
    const getAggsRange = jest
      .fn()
      .mockResolvedValue([
        bar("2026-10-01", 764.02),
        bar("2026-10-02", 769.64),
        bar("2026-10-05", 772.1),
      ]);
    let now = et("2026-10-05T08:00:00");
    const cache = new DailyClosesCache({ getAggsRange }, logger, () => now);

    expect((await cache.get("SPY"))?.last.date).toBe("2026-10-02");
    expect((await cache.get("SPY"))?.last.date).toBe("2026-10-02");
    expect(getAggsRange).toHaveBeenCalledTimes(1);

    now = et("2026-10-05T20:30:00");
    expect((await cache.get("SPY"))?.last.date).toBe("2026-10-05");
    expect(getAggsRange).toHaveBeenCalledTimes(2);
  });

  it("serves the previous pair when the vendor fails", async () => {
    const getAggsRange = jest
      .fn()
      .mockResolvedValueOnce([
        bar("2026-10-01", 764.02),
        bar("2026-10-02", 769.64),
      ])
      .mockRejectedValueOnce(new Error("boom"));
    let now = et("2026-10-05T08:00:00");
    const cache = new DailyClosesCache({ getAggsRange }, logger, () => now);
    await cache.get("SPY");
    now = et("2026-10-05T20:30:00");
    expect((await cache.get("SPY"))?.last.date).toBe("2026-10-02");
    expect(logger.warn).toHaveBeenCalled();
  });
});
