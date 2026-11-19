import { MarketDataService } from "./market-data.service";
import { PolygonService } from "../polygon/polygon.service";
import type { ConfigService } from "@nestjs/config";
import type { FmpService } from "../fmp/fmp.service";
import type { SecEdgarService } from "../sec-edgar/sec-edgar.service";

const config = {
  get: (_k: string, d?: unknown) => d,
} as unknown as ConfigService;

// Nov 19 workbook row 2: BRK.B −3.07% (vs the Nov 17 close) instead of −1.01%.
describe("getUniversalSnapshot measures the day from the official previous close", () => {
  afterEach(() => jest.restoreAllMocks());
  it("FMP rows are re-based on the grouped-daily close of the last session", async () => {
    jest.useFakeTimers({
      now: Date.parse("2026-11-19T15:55:00Z"),
      doNotFake: ["nextTick", "setImmediate", "setTimeout"],
    });
    const request = jest.fn((path: string) =>
      Promise.resolve(
        path.startsWith("batch-quote")
          ? [
              {
                symbol: "BRK-B",
                price: 568.8,
                previousClose: 586.76,
                changePercentage: -3.06,
                dayLow: 567.93,
                dayHigh: 573.13,
                timestamp: Date.parse("2026-11-19T15:54:50Z") / 1000,
              },
            ]
          : [],
      ),
    );
    const svc = new MarketDataService(
      config,
      {
        enabled: true,
        request,
        getExtendedTrades: jest.fn().mockResolvedValue([]),
      } as unknown as FmpService,
      {} as SecEdgarService,
    );
    jest
      .spyOn(PolygonService.prototype, "getGroupedDaily")
      .mockImplementation((d: string) =>
        Promise.resolve(
          d === "2026-11-18"
            ? ([...Array(150)]
                .map((_, i) => ({ T: `X${i}`, c: 1 }))
                .concat([{ T: "BRK.B", c: 574.62 }]) as never)
            : ([] as never),
        ),
      );
    jest
      .spyOn(PolygonService.prototype, "getUniversalSnapshotRaw")
      .mockResolvedValue([
        {
          ticker: "BRK.B",
          session: {
            previous_close: 586.76,
            low: 567.1,
            high: 573.13,
            price: 568.8,
          },
          last_minute: {
            last_updated: Date.parse("2026-11-19T15:54:00Z") * 1e6,
          },
        },
      ]);
    const [row] = await svc.getUniversalSnapshot(["BRK.B"]);
    jest.useRealTimers();
    expect(row.previousClose).toBe(574.62);
    expect(row.changePercent).toBeCloseTo(-1.01, 2);
  });
});
