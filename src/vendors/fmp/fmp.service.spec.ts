import { FmpService } from "./fmp.service";
import { Logger } from "@nestjs/common";

describe("FmpService - getEarningsCalendar cap and chunking", () => {
  it("splits multi-week range into weekly windows, merges and de-duplicates", async () => {
    const requestedUrls: string[] = [];
    const configMock = {
      get: (k: string, def = "") => (k === "FMP_API_KEY" ? "test_key" : def),
    };
    const service = new FmpService(configMock as any);

    // Spy on get()
    jest.spyOn(service as any, "get").mockImplementation(async (path: string) => {
      requestedUrls.push(path);
      if (path.includes("from=2026-10-01&to=2026-10-07")) {
        return [
          { date: "2026-10-02", symbol: "AAPL", epsEstimated: 1.5 },
          { date: "2026-10-05", symbol: "MSFT", epsEstimated: 2.5 },
        ];
      }
      if (path.includes("from=2026-10-08&to=2026-10-14")) {
        return [
          { date: "2026-10-05", symbol: "MSFT", epsEstimated: 2.5 }, // duplicate
          { date: "2026-10-12", symbol: "JJSF", epsEstimated: 1.25 },
        ];
      }
      return [];
    });

    // Request a 14-day window: 2026-10-01 to 2026-10-14
    const result = await service.getEarningsCalendar("2026-10-01", "2026-10-14");

    // Must split into weekly windows (at least 2 requests for 14 days)
    expect(requestedUrls.length).toBeGreaterThanOrEqual(2);
    // Must contain JJSF and deduplicated MSFT
    expect(result.length).toBe(3);
    expect(result.map((r) => r.symbol).sort()).toEqual(["AAPL", "JJSF", "MSFT"]);
  });

  it("logs a warning whenever any response returns exactly the 4,000-row cap", async () => {
    const configMock = {
      get: (k: string, def = "") => (k === "FMP_API_KEY" ? "test_key" : def),
    };
    const service = new FmpService(configMock as any);

    // Mock 4000 rows (exact cap)
    const mocked4kRows = Array.from({ length: 4000 }, (_, i) => ({
      date: "2026-10-01",
      symbol: `SYM${i}`,
      epsEstimated: 1.0,
    }));

    jest.spyOn(service as any, "get").mockResolvedValue(mocked4kRows);
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

    await service.getEarningsCalendar("2026-10-01", "2026-10-05");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/4000|cap/i),
    );
    warnSpy.mockRestore();
  });
});
