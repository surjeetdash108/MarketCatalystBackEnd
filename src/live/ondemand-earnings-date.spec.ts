import { OnDemandService } from "./ondemand.service";

describe("OnDemandService.getCompany returns earliest upcoming earnings date (Item 2)", () => {
  function harness(storedNextEarningsDate: string | null, fmpNextDate: string | null) {
    const docData = {
      ticker: "JACK",
      price: 50.0,
      nextEarningsDate: storedNextEarningsDate,
      createdAt: new Date().toISOString(),
    };
    const firebase = {
      firestore: {
        collection: (name: string) => ({
          doc: (key: string) => ({
            get: () => Promise.resolve({ exists: true, data: () => docData }),
            set: () => Promise.resolve(),
          }),
          where: () => ({ get: () => Promise.resolve({ docs: [] }) }),
        }),
      },
    };
    const estimatesAdapter = {
      getEpsHistory: jest.fn().mockResolvedValue(
        fmpNextDate
          ? [{ date: fmpNextDate, epsActual: null, epsEstimated: 0.5 }]
          : [],
      ),
    };
    const delisted = { isDelisted: jest.fn().mockResolvedValue(false) };
    const fmp = { enabled: false };
    const svc = new OnDemandService(
      firebase as never, null as never, null as never, null as never, null, estimatesAdapter as never,
      null as never, fmp as never, null as never, delisted as never, null as never,
    );
    jest.spyOn(svc, "recordUsage").mockImplementation(() => undefined);
    return svc;
  }

  it("selects earliest upcoming date when stored is later than FMP next report date (JACK Nov 18 vs Nov 25)", async () => {
    // Stored is 2026-11-25, FMP reports 2026-11-18
    const svc = harness("2026-11-25", "2026-11-18");
    const result = await svc.getCompany("JACK");
    expect(result).not.toBeNull();
    expect(result?.nextEarningsDate).toBe("2026-11-18");
  });

  it("keeps stored date if FMP has no upcoming date", async () => {
    const svc = harness("2026-11-25", null);
    const result = await svc.getCompany("JACK");
    expect(result?.nextEarningsDate).toBe("2026-11-25");
  });

  it("replaces past stored date with upcoming FMP date", async () => {
    const svc = harness("2025-10-10", "2026-11-18");
    const result = await svc.getCompany("JACK");
    expect(result?.nextEarningsDate).toBe("2026-11-18");
  });
});
