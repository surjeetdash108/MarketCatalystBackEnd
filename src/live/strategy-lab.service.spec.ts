import {
  StrategyLabService,
  dropUnfinishedDay,
  toBars,
  type LabBar,
} from "./strategy-lab.service";

const bar = (d: string, c = 10): LabBar => [d, c, c, c, c, 100];

describe("Strategy Lab bars", () => {
  afterEach(() => jest.useRealTimers());

  it("toBars keeps priced rows only, ascending", () => {
    const out = toBars(
      [
        { date: "2026-10-20", open: 2, high: 3, low: 1, close: 2.5, volume: 7 },
        { date: "2026-10-19", open: 1, high: 2, low: 1, close: 1.5, volume: 5 },
        { date: "2026-10-18", open: 0, high: 0, low: 0, close: 0, volume: 0 },
      ],
      (d) => d,
    );
    expect(out).toEqual([
      ["2026-10-19", 1, 2, 1, 1.5, 5],
      ["2026-10-20", 2, 3, 1, 2.5, 7],
    ]);
  });

  it("drops today's still-forming daily bar until 16:15 ET, keeps it after", () => {
    const rows = [bar("2026-10-20"), bar("2026-10-21")];
    expect(
      dropUnfinishedDay(rows, Date.parse("2026-10-21T14:44:00Z")).map(
        (b) => b[0],
      ),
    ).toEqual(["2026-10-20"]); // 10:44 ET
    expect(
      dropUnfinishedDay(rows, Date.parse("2026-10-21T20:30:00Z")).map(
        (b) => b[0],
      ),
    ).toEqual(["2026-10-20", "2026-10-21"]); // 16:30 ET
    expect(
      dropUnfinishedDay(
        [bar("2026-10-20")],
        Date.parse("2026-10-21T14:44:00Z"),
      ),
    ).toHaveLength(1); // no today bar
  });

  it("pages FMP's intraday chart backwards to cover the window, regular session only", async () => {
    jest.useFakeTimers().setSystemTime(Date.parse("2026-10-21T20:30:00Z"));
    const page = (day: string) => [
      {
        date: `${day} 09:25:00`,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
      }, // pre-market
      {
        date: `${day} 09:30:00`,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
      },
      {
        date: `${day} 15:55:00`,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
      },
      {
        date: `${day} 16:00:00`,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
      }, // after the bell
    ];
    const request = jest.fn(async (path: string) => {
      const to = /&to=(\d{4}-\d{2}-\d{2})/.exec(path)?.[1];
      return to === "2026-10-21"
        ? page("2026-10-20")
        : to === "2026-10-19"
          ? page("2026-10-16")
          : [];
    });
    const svc = new StrategyLabService(
      { request } as never,
      { enabled: false } as never,
    );
    const { bars } = await svc.bars(["AAPL"], "5m", { days: 7 });
    expect(bars.AAPL.map((b) => b[0])).toEqual([
      "2026-10-16 09:30:00",
      "2026-10-16 15:55:00",
      "2026-10-20 09:30:00",
      "2026-10-20 15:55:00",
    ]);
    expect(request).toHaveBeenCalledTimes(3); // 10-21 → 10-19 → (empty) stop
  });

  it("reports symbols FMP has nothing for instead of failing the batch, and caches", async () => {
    jest.useFakeTimers().setSystemTime(Date.parse("2026-10-21T21:00:00Z"));
    const request = jest.fn(async (path: string) =>
      path.includes("ZZZZ")
        ? []
        : [
            {
              date: "2026-10-20",
              open: 1,
              high: 1,
              low: 1,
              close: 1,
              volume: 1,
            },
          ],
    );
    const svc = new StrategyLabService(
      { request } as never,
      { enabled: false } as never,
    );
    const r = await svc.bars(["AAPL", "ZZZZ"], "d", { years: 6 });
    expect(Object.keys(r.bars)).toEqual(["AAPL"]);
    expect(r.missing).toEqual(["ZZZZ"]);
    await svc.bars(["AAPL"], "d", { years: 6 });
    expect(request).toHaveBeenCalledTimes(2); // AAPL served from cache the second time
  });

  it("returns null from aiRules when no model is configured", async () => {
    const svc = new StrategyLabService(
      { request: jest.fn() } as never,
      { enabled: false } as never,
    );
    await expect(svc.aiRules("buy when RSI(2) < 10")).resolves.toBeNull();
  });
});
