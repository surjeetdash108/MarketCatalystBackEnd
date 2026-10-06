import { TapeService, type TapeFrame } from "./tape.service";

/** A wall-clock instant given as New York time (EDT, UTC-4, in October). */
const et = (iso: string) => new Date(`${iso}-04:00`);

type Row = {
  ticker: string;
  name?: string;
  price: number | null;
  changePercent: number | null;
  previousClose: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
};

/** Polygon universal-snapshot rows as polygon.service maps them. */
function snapshot(rows: Row[]) {
  return rows.map((r) => ({
    name: r.ticker,
    open: null,
    high: null,
    low: null,
    ...r,
  }));
}

const quote = (symbol: string, price: number, pct: number, prev: number) => ({
  symbol,
  price,
  change: Math.round((price - prev) * 1000) / 1000,
  changePercentage: pct,
  previousClose: prev,
  open: prev,
  dayHigh: price + 1,
  dayLow: prev - 1,
  volume: 0,
  timestamp: 1_790_000_000,
});

/** FMP's answer for every non-stock tile, as seen on 2026-10-05 ~04:15 ET. */
const ALL_FMP = [
  quote("^GSPC", 7722.72, 0.73, 7666.45),
  quote("^IXIC", 27190.863, 1.19, 26871.6),
  quote("^DJI", 51176.96, 0.49, 50926.56),
  quote("^RUT", 2832.8948, 0.94, 2806.625),
  quote("^VIX", 16.24, 6.07, 15.31),
  quote("CLUSD", 89.35, -1.93, 91.11),
  quote("GCUSD", 4194, 0.76, 4162.3),
  quote("DX-Y.NYB", 101.95, 0.02, 101.932),
  quote("BTCUSD", 86383.0, -0.15, 86513.38),
  quote("ETHUSD", 2730.03, 0.12, 2726.724),
  quote("^TNX", 5.277, 0.76, 5.237),
];

const dailyBar = (date: string, c: number) => ({
  t: et(`${date}T00:00:00`).getTime(),
  o: c - 1,
  h: c + 2,
  l: c - 3,
  c,
  v: 1,
  T: "X",
});

type Quote = ReturnType<typeof quote>;
type FmpAnswer = Quote[] | Error;

function build(opts: {
  phase: TapeFrame["marketPhase"];
  rows?: Row[];
  /** One FMP answer per call, in order; the last one repeats. */
  fmp?: FmpAnswer[];
  fmpEnabled?: boolean;
  bars?: Record<string, ReturnType<typeof dailyBar>[]>;
}) {
  const polygon = {
    getUniversalSnapshot: jest
      .fn()
      .mockResolvedValue(snapshot(opts.rows ?? [])),
    getTreasuryYields: jest
      .fn()
      .mockResolvedValue([{ yield10Year: 4.1 }, { yield10Year: 4.0 }]),
    getAggsRange: jest.fn((ticker: string) =>
      Promise.resolve(opts.bars?.[ticker] ?? []),
    ),
  };
  const answers: FmpAnswer[] = opts.fmp ?? [[]];
  let call = 0;
  const fmp = {
    enabled: opts.fmpEnabled ?? true,
    getQuotes: jest.fn((symbols: string[]) => {
      const a = answers[Math.min(call++, answers.length - 1)];
      return a instanceof Error
        ? Promise.reject(a)
        : Promise.resolve(a.filter((q) => symbols.includes(q.symbol)));
    }),
  };
  const marketStatus = {
    get: jest.fn().mockResolvedValue({ phase: opts.phase }),
  };
  const fred = {
    getLatestObservations: jest
      .fn()
      .mockResolvedValue([{ value: "60" }, { value: "59" }]),
  };
  const config = { get: jest.fn().mockReturnValue("AAPL") };
  const svc = new TapeService(
    polygon as any,
    marketStatus as any,
    fred as any,
    fmp as any,
    config as any,
  );
  return { svc, polygon, fmp, fred };
}

const item = (f: TapeFrame, id: string) => f.items.find((i) => i.id === id)!;
const refresh = (svc: TapeService) =>
  (svc as unknown as { refresh(): Promise<void> }).refresh();

describe("TapeService non-stock tiles come from FMP", () => {
  afterEach(() => jest.useRealTimers());

  it("asks FMP once per refresh for every non-stock tile", async () => {
    const { svc, fmp } = build({ phase: "open", fmp: [ALL_FMP] });
    await svc.currentFrame();
    expect(fmp.getQuotes).toHaveBeenCalledTimes(1);
    expect([...fmp.getQuotes.mock.calls[0][0]].sort()).toEqual(
      ALL_FMP.map((q) => q.symbol).sort(),
    );
  });

  it("shows the instrument's own level, move and previous close", async () => {
    const { svc } = build({
      phase: "open",
      rows: [
        {
          ticker: "SPY",
          price: 769.11,
          changePercent: 0.67,
          previousClose: 763.99,
        },
      ],
      fmp: [ALL_FMP],
    });
    const f = await svc.currentFrame();
    const spx = item(f, "SPX");
    expect(spx.value).toBe(7722.72); // not SPY × 10
    expect(spx.pctChange).toBe(0.73);
    expect(spx.change).toBe(0.73); // percent move on every price tile
    expect(spx.prevClose).toBe(7666.45);
    expect(spx.isProxy).toBe(false);
    expect(spx.stale).toBeUndefined();
    expect(item(f, "NDX").value).toBe(27190.863); // the Composite, as on Yahoo
    expect(item(f, "GOLD").value).toBe(4194); // not GLD × 10.89
    expect(item(f, "DXY").value).toBe(101.95); // not UUP's share price
    expect(item(f, "WTI").value).toBe(89.35);
    expect(item(f, "BTC").value).toBe(86383.0);
    expect(item(f, "ETH").pctChange).toBe(0.12);
  });

  it("keeps the 10Y tile's absolute (percentage-point) change", async () => {
    const { svc } = build({ phase: "open", fmp: [ALL_FMP] });
    const tnx = item(await svc.currentFrame(), "US10Y");
    expect(tnx.value).toBe(5.277);
    expect(tnx.unit).toBe("percent");
    expect(tnx.change).toBe(0.04); // 5.277 - 5.237, not 0.76
    expect(tnx.pctChange).toBe(0.76);
    expect(tnx.prevClose).toBe(5.237);
  });

  it("never touches the old sources while FMP is configured", async () => {
    const { svc, polygon, fred } = build({ phase: "open", fmp: [ALL_FMP] });
    await svc.currentFrame();
    expect(fred.getLatestObservations).not.toHaveBeenCalled();
    expect(polygon.getTreasuryYields).not.toHaveBeenCalled();
  });

  it("keeps the last good FMP value when a refresh gets no answer, marked stale", async () => {
    const { svc } = build({
      phase: "open",
      fmp: [ALL_FMP, new Error("FMP -> 503")],
    });
    await refresh(svc);
    await refresh(svc);
    const f = svc.lastKnownFrame!;
    expect(f.stale).toBe(false); // the frame is fine; the tiles say they are not fresh
    expect(item(f, "SPX").value).toBe(7722.72);
    expect(item(f, "SPX").stale).toBe(true);
  });

  it("shows an empty tile rather than an ETF approximation when FMP never answered", async () => {
    const { svc } = build({
      phase: "open",
      rows: [
        {
          ticker: "SPY",
          price: 769.11,
          changePercent: 0.67,
          previousClose: 763.99,
        },
      ],
      fmp: [[]],
    });
    const spx = item(await svc.currentFrame(), "SPX");
    expect(spx.value).toBeNull();
    expect(spx.pctChange).toBeNull();
  });

  it("refreshes what FMP priced; the rest keep their last good value", async () => {
    const withoutGold = ALL_FMP.filter((q) => q.symbol !== "GCUSD");
    const { svc } = build({ phase: "open", fmp: [ALL_FMP, withoutGold] });
    await refresh(svc);
    await refresh(svc);
    const f = svc.lastKnownFrame!;
    expect(item(f, "GOLD").value).toBe(4194);
    expect(item(f, "GOLD").stale).toBe(true);
    expect(item(f, "SPX").stale).toBeUndefined();
  });

  it("backs off FMP after an empty answer, then retries", async () => {
    jest.useFakeTimers({ now: et("2026-10-05T10:00:00") });
    const { svc, fmp } = build({ phase: "open", fmp: [[]] });
    await refresh(svc);
    await refresh(svc);
    expect(fmp.getQuotes).toHaveBeenCalledTimes(1);
    jest.setSystemTime(et("2026-10-05T10:06:00"));
    await refresh(svc);
    expect(fmp.getQuotes).toHaveBeenCalledTimes(2);
  });

  it("keeps refreshing FMP tiles while the market is closed (crypto, futures, overnight VIX)", async () => {
    const later = ALL_FMP.map((q) =>
      q.symbol === "BTCUSD" ? quote("BTCUSD", 87000, 0.56, 86513.38) : q,
    );
    const { svc, fmp, polygon } = build({
      phase: "closed",
      rows: [
        {
          ticker: "AAPL",
          price: 333.69,
          changePercent: 1.02,
          previousClose: 330.32,
        },
      ],
      fmp: [ALL_FMP, later],
    });
    await refresh(svc);
    await refresh(svc);
    expect(fmp.getQuotes).toHaveBeenCalledTimes(2);
    expect(polygon.getUniversalSnapshot).toHaveBeenCalledTimes(1); // stocks stay frozen while closed
    expect(item(svc.lastKnownFrame!, "BTC").value).toBe(87000);
    expect(item(svc.lastKnownFrame!, "AAPL").pctChange).toBe(1.02);
  });
});

describe("TapeService without an FMP key (old sources)", () => {
  afterEach(() => jest.useRealTimers());

  it("falls back to the ETF proxy, FRED and treasury series", async () => {
    const { svc, fmp, fred, polygon } = build({
      phase: "open",
      fmpEnabled: false,
      rows: [
        {
          ticker: "SPY",
          price: 769.11,
          changePercent: 0.67,
          previousClose: 763.99,
        },
      ],
    });
    const f = await svc.currentFrame();
    expect(fmp.getQuotes).not.toHaveBeenCalled();
    expect(item(f, "SPX").value).toBeCloseTo(7691.1, 6);
    expect(item(f, "SPX").isProxy).toBe(true);
    expect(item(f, "WTI").value).toBe(60);
    expect(fred.getLatestObservations).toHaveBeenCalled();
    expect(polygon.getTreasuryYields).toHaveBeenCalled();
    expect(item(f, "US10Y").value).toBe(4.1);
  });

  it("rebuilds a rolled proxy tile from the last two sessions (T175)", async () => {
    jest.useFakeTimers({ now: et("2026-10-05T02:46:00") });
    const { svc } = build({
      phase: "closed",
      fmpEnabled: false,
      rows: [
        {
          ticker: "SPY",
          price: 769.64,
          changePercent: 0,
          previousClose: 769.64,
        },
      ],
      bars: {
        SPY: [dailyBar("2026-10-01", 764.02), dailyBar("2026-10-02", 769.64)],
      },
    });
    const spx = item(await svc.currentFrame(), "SPX");
    expect(spx.value).toBeCloseTo(7696.4, 6);
    expect(spx.prevClose).toBeCloseTo(7640.2, 6);
    expect(spx.pctChange).toBe(0.74);
    expect(spx.asOfDate).toBe("2026-10-02");
  });
});

describe("TapeService stock tiles: rollover (T175)", () => {
  afterEach(() => jest.useRealTimers());

  const rolledAapl = {
    ticker: "AAPL",
    price: 333.69,
    changePercent: 0,
    previousClose: 333.69,
  };

  it("rebuilds a rolled stock tile from the last two completed sessions", async () => {
    jest.useFakeTimers({ now: et("2026-10-05T02:46:00") }); // Monday, before pre-market
    const { svc } = build({
      phase: "closed",
      rows: [rolledAapl],
      fmp: [ALL_FMP],
      bars: {
        AAPL: [dailyBar("2026-10-01", 330.32), dailyBar("2026-10-02", 333.69)],
      },
    });
    const aapl = item(await svc.currentFrame(), "AAPL");
    expect(aapl.value).toBe(333.69);
    expect(aapl.prevClose).toBe(330.32);
    expect(aapl.pctChange).toBe(1.02);
    expect(aapl.change).toBe(1.02);
    expect(aapl.dayHigh).toBe(335.69); // the last session's own range
    expect(aapl.asOfDate).toBe("2026-10-02");
  });

  it("never rebuilds during the regular session", async () => {
    const { svc, polygon } = build({
      phase: "open",
      rows: [rolledAapl],
      fmp: [ALL_FMP],
    });
    expect(item(await svc.currentFrame(), "AAPL").pctChange).toBe(0);
    expect(polygon.getAggsRange).not.toHaveBeenCalled();
  });

  it("keeps a real after-hours figure untouched", async () => {
    const { svc, polygon } = build({
      phase: "after",
      rows: [
        {
          ticker: "AAPL",
          price: 333.69,
          changePercent: 1.02,
          previousClose: 330.32,
        },
      ],
      fmp: [ALL_FMP],
    });
    expect(item(await svc.currentFrame(), "AAPL").pctChange).toBe(1.02);
    expect(polygon.getAggsRange).not.toHaveBeenCalled();
  });

  it("keeps the rolled figure when no daily bars are available", async () => {
    jest.useFakeTimers({ now: et("2026-10-05T02:46:00") });
    const { svc } = build({
      phase: "closed",
      rows: [rolledAapl],
      fmp: [ALL_FMP],
      bars: {},
    });
    const aapl = item(await svc.currentFrame(), "AAPL");
    expect(aapl.value).toBe(333.69);
    expect(aapl.pctChange).toBe(0);
  });
});
