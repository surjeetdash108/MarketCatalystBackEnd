import * as fs from "fs";
import * as path from "path";
import { BarsLru } from "./bars-cache";
import { packFromRows, type LabBar } from "./bar-pack";
import { lastCompletedSession } from "./sessions";
import { StrategyLabService } from "../strategy-lab.service";

/** Real FMP daily bars for AAPL, 2024-10-01 → 2026-10-30 (split-adjusted). */
const AAPL = (
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../fixtures/lab-daily-aapl-2026-10-30.json"),
      "utf-8",
    ),
  ) as { rows: LabBar[] }
).rows;
/** FMP's eod/full row shape for the same bars. */
const fmpRows = (rows: LabBar[]) =>
  rows.map(([date, open, high, low, close, volume]) => ({
    date,
    open,
    high,
    low,
    close,
    volume,
  }));

describe("bars cache (LRU, capped by total bars)", () => {
  it("evicts the least recently used entries once the bar total passes the cap", () => {
    const c = new BarsLru(1000);
    c.set("a", AAPL.slice(0, 400));
    c.set("b", AAPL.slice(0, 400));
    expect(c.get("a", 60_000)).toHaveLength(400); // a is now the most recent
    c.set("c", AAPL.slice(0, 400)); // 1200 > 1000 → drop b, the least recent
    expect(c.get("b", 60_000)).toBeUndefined();
    expect(c.get("a", 60_000)).toHaveLength(400);
    expect(c.get("c", 60_000)).toHaveLength(400);
    expect(c.bars).toBe(800);
  });
  it("treats entries older than the max age as missing", () => {
    const c = new BarsLru(1000);
    c.set("a", AAPL.slice(0, 10));
    expect(c.get("a", -1)).toBeUndefined();
  });
});

describe("daily /bars reads the stored packs first (LAB_BARS_FROM_STORE=1)", () => {
  // Saturday 2026-10-31: the last completed session is Friday 2026-10-30.
  const NOW = Date.parse("2026-10-31T15:00:00Z");
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  const make = (packs: Record<string, LabBar[]>, on = true) => {
    const request = jest.fn((p: string) => {
      const from = /&from=(\d{4}-\d{2}-\d{2})/.exec(p)?.[1] ?? "";
      return Promise.resolve(fmpRows(AAPL.filter((r) => r[0] >= from)));
    });
    const readDailyMany = jest.fn((ts: string[]) =>
      Promise.resolve(
        new Map(
          ts
            .filter((t) => packs[t])
            .map((t) => [t, packFromRows(packs[t], false)]),
        ),
      ),
    );
    const svc = new StrategyLabService(
      { request } as never,
      { enabled: false } as never,
      {} as never,
      { readDailyMany } as never,
      {
        get: (k: string) => (k === "LAB_BARS_FROM_STORE" && on ? "1" : ""),
      } as never,
    );
    return { svc, request, readDailyMany };
  };

  it("serves a fresh pack without calling FMP, cut to the requested span", async () => {
    expect(lastCompletedSession(NOW)).toBe("2026-10-30");
    const { svc, request } = make({ AAPL });
    const r = await svc.bars(["AAPL"], "d", { years: 1 });
    expect(request).not.toHaveBeenCalled();
    expect(r.bars.AAPL[0][0] >= "2025-10-31").toBe(true);
    expect(r.bars.AAPL.at(-1)?.[0]).toBe("2026-10-30");
  });

  it("returns exactly what the FMP path returns for the same bars", async () => {
    const store = await make({ AAPL }).svc.bars(["AAPL"], "d", { years: 1 });
    const fmp = await make({}, false).svc.bars(["AAPL"], "d", { years: 1 });
    expect(store.bars.AAPL).toEqual(fmp.bars.AAPL);
  });

  it("falls back to FMP for a stale pack, a missing pack, or a span older than the packs keep", async () => {
    const stale = make({ AAPL: AAPL.slice(0, -1) }); // last bar 2026-10-29
    await stale.svc.bars(["AAPL"], "d", { years: 1 });
    expect(stale.request).toHaveBeenCalledTimes(1);
    const missing = make({});
    await missing.svc.bars(["AAPL"], "d", { years: 1 });
    expect(missing.request).toHaveBeenCalledTimes(1);
    const old = make({ AAPL });
    await old.svc.bars(["AAPL"], "d", { days: 4026 });
    expect(old.request).toHaveBeenCalledTimes(1);
  });

  it("is off unless LAB_BARS_FROM_STORE=1", async () => {
    const { svc, request, readDailyMany } = make({ AAPL }, false);
    await svc.bars(["AAPL"], "d", { years: 1 });
    expect(readDailyMany).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
