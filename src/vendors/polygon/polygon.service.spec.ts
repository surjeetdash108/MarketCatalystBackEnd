import { PolygonService } from "./polygon.service";

describe("PolygonService resilience", () => {
  it("getLatestGroupedDaily falls back to prior candidate date when today throws 403 pre-close", async () => {
    const service = new PolygonService({
      get: jest.fn().mockReturnValue("test-key"),
    } as any, null as any);

    const getGroupedDailySpy = jest.spyOn(service, "getGroupedDaily").mockImplementation(async (date: string) => {
      if (date === "2026-10-24") {
        throw new Error("HTTP 403: Attempted to request today's data before end of day");
      }
      if (date === "2026-10-23") {
        return [{ T: "AAPL", o: 200, h: 205, l: 199, c: 202, v: 50000000, t: 1729700000000 }];
      }
      return [];
    });

    const result = await service.getLatestGroupedDaily(["2026-10-24", "2026-10-23"]);
    expect(result).not.toBeNull();
    expect(result?.date).toBe("2026-10-23");
    expect(result?.bars).toHaveLength(1);
    expect(getGroupedDailySpy).toHaveBeenCalledTimes(2);
  });

  describe("retired /vX/reference/financials (410 Gone)", () => {
    // The production earnings job's recorded failure (sync_meta snapshot, 2026-10-26).
    const fx = require("../../common/fixtures/sync-meta-2026-10-26.json");
    const body = String(fx.earnings.lastError).replace(/^.*?-> 410: /, "");
    const make = () => new PolygonService({ get: jest.fn((_k: string, d?: string) => d ?? "test-key") } as any, null as any);
    let fetchSpy: jest.SpyInstance;
    beforeEach(() => {
      fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(body, { status: 410 }));
    });
    afterEach(() => fetchSpy.mockRestore());

    it("the earnings job's filing-date read returns [] without a request", async () => {
      await expect(make().getFinancialsByFilingDate("2026-04-29", "2026-10-26")).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("a live 410 latches the endpoint off instead of throwing", async () => {
      const svc = make();
      (svc as any).massiveFinancialsUnavailable = false;
      await expect(svc.getFinancialsByFilingDate("2026-04-29", "2026-10-26")).resolves.toEqual([]);
      expect((svc as any).massiveFinancialsUnavailable).toBe(true);
    });
  });
});
