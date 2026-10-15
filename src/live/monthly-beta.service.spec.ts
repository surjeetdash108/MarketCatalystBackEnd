import { MonthlyBetaService, type MarketMonths } from "./monthly-beta.service";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";
import type { PolygonService } from "../vendors/polygon/polygon.service";

/** 37 month-ends (36 returns), Sep 2023 → Sep 2026. */
const dates: string[] = [];
for (let i = 0; i < 37; i++) {
  const d = new Date(Date.UTC(2023, 8 + i + 1, 0)); // last day of month
  dates.push(d.toISOString().slice(0, 10));
}
const mktReturns = dates.map((_, i) => [0.02, -0.015, 0.03, -0.01][i % 4]);
const closesFrom = (scale: number, start: number) => {
  let px = start;
  return dates.map((_, i) =>
    i === 0 ? px : (px *= 1 + mktReturns[i] * scale),
  );
};
const spy = closesFrom(1, 500);
const market: MarketMonths = {
  dates,
  closes: new Map(dates.map((d, i) => [d.slice(0, 7), spy[i]])),
  asOf: "2026-09",
};

function harness(storedCloses: (number | null)[], vendorCloses: number[]) {
  const getAll = jest.fn((...args: unknown[]) =>
    Promise.resolve(
      args.slice(0, -1).map((_, i) => ({
        exists: storedCloses[i] != null,
        get: () => storedCloses[i],
      })),
    ),
  );
  const firebase = {
    firestore: { collection: () => ({ doc: (id: string) => id }), getAll },
  } as unknown as FirebaseAdminService;
  const getAggsRange = jest.fn(() =>
    Promise.resolve(
      vendorCloses.map((c, i) => ({
        // Polygon stamps a monthly bar at midnight New York on the 1st.
        t: Date.parse(`${dates[i].slice(0, 7)}-01T04:00:00Z`),
        c,
      })),
    ),
  );
  const polygon = { getAggsRange } as unknown as PolygonService;
  return {
    svc: new MonthlyBetaService(firebase, polygon),
    getAll,
    getAggsRange,
  };
}

describe("MonthlyBetaService.computeFor", () => {
  const stock = closesFrom(1.5, 100);

  it("uses stored month-end bars when they cover every month — no vendor call", async () => {
    const { svc, getAggsRange } = harness(stock, []);
    const r = await svc.computeFor("AAA", market);
    expect(r.source).toBe("ohlcv_bars");
    expect(r.beta.beta).toBeCloseTo(1.5, 3);
    expect(r.asOf).toBe("2026-09");
    expect(getAggsRange).not.toHaveBeenCalled();
  });

  it("falls back to Polygon monthly bars when stored history is short", async () => {
    const stored = stock.map((c, i) => (i < 20 ? null : c));
    const { svc, getAggsRange } = harness(stored, stock);
    const r = await svc.computeFor("AAA", market);
    expect(r.source).toBe("polygon");
    expect(r.beta.months).toBe(36);
    // limit caps the DAILY bars Polygon rolls up; a small one returns ~6 months.
    expect(getAggsRange).toHaveBeenCalledWith(
      "AAA",
      expect.any(String),
      "2026-09-30",
      "month",
      1,
      50_000,
    );
  });

  it("skips stored bars entirely while a split re-backfill is pending", async () => {
    const { svc, getAll } = harness(stock, stock);
    const r = await svc.computeFor("AAA", market, { historyPending: true });
    expect(r.source).toBe("polygon");
    expect(getAll).not.toHaveBeenCalled();
  });

  it("keeps the stored series when the vendor call fails", async () => {
    const stored = stock.map((c, i) => (i < 5 ? null : c));
    const { svc, getAggsRange } = harness(stored, []);
    getAggsRange.mockRejectedValueOnce(new Error("429"));
    const r = await svc.computeFor("AAA", market);
    expect(r.source).toBe("ohlcv_bars");
    expect(r.beta.months).toBe(31);
  });
});
