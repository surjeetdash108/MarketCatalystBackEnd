import { OnDemandService } from "./ondemand.service";

/**
 * 27 Nov: a /live/company rebuild whose technicals step failed (Firestore
 * DEADLINE_EXCEEDED, returns {}) answered WITHOUT high52 / low52 and the other
 * technicals, and kept that thin doc in memory for 5 minutes, so Stock
 * Intelligence read "52-week range —" and shifted its scores, although the
 * stored doc (written with merge:true) still held every one of those fields and
 * served them again once the memory copy expired. The doc a rebuild returns and
 * caches must be what Firestore holds after the merge write.
 */
describe("OnDemandService.getCompany serves what Firestore holds after a rebuild's merge", () => {
  // Older than COMPANY_TTL_MS (15 min), so the request rebuilds.
  const stale = new Date(Date.now() - 20 * 60_000).toISOString();
  const stored = {
    ticker: "NVDA",
    name: "NVIDIA Corporation",
    description: "Stored profile text",
    sector: "Technology",
    exchange: "XNAS",
    marketCap: 3.9e12,
    price: 160,
    high52: 243.37,
    low52: 124.5,
    pctFromHigh52: -34.3,
    rsi14: 41,
    sma50: 170,
    sma200: 150,
    createdAt: stale,
  };
  const freshDetails = {
    name: "NVIDIA Corporation",
    description: "Fresh vendor text",
    market_cap: 3.6e12,
    weighted_shares_outstanding: 24.3e9,
    primary_exchange: "XNAS",
    sic_code: "3674",
    sic_description: "Semiconductors",
  };

  function harness(opts: { technicals: Record<string, unknown>; details: Record<string, unknown> | null }) {
    const written: Array<{ data: Record<string, unknown>; options: unknown }> = [];
    const firebase = {
      firestore: {
        collection: (name: string) => ({
          doc: () => ({
            get: () =>
              Promise.resolve(
                name === "companies" ? { exists: true, data: () => stored } : { exists: false, data: () => undefined },
              ),
            set: (data: Record<string, unknown>, options: unknown) => {
              if (name === "companies") written.push({ data, options });
              return Promise.resolve();
            },
          }),
          where: () => ({ get: () => Promise.resolve({ docs: [] }) }),
        }),
      },
    };
    const polygon = {
      getTickerDetails: jest.fn().mockResolvedValue(opts.details),
      getUniversalSnapshot: jest
        .fn()
        .mockResolvedValue([{ price: 149.3, changePercent: -3.9, previousClose: 155.4, volume: 1_000_000 }]),
      getTtmEps: jest.fn().mockResolvedValue(9.31),
      getRelatedCompanies: jest.fn().mockResolvedValue(["AMD"]),
      getDividendHistory: jest.fn().mockResolvedValue([]),
    };
    // These two FMP calls run even with FMP switched off.
    const fmp = {
      enabled: false,
      getLatestInstitutionalOwnership: jest.fn().mockResolvedValue(null),
      getCompanyProfile: jest.fn().mockResolvedValue(null),
    };
    const secEdgar = { getSicByTicker: jest.fn().mockResolvedValue(null) };
    const delisted = { isDelisted: jest.fn().mockResolvedValue(false) };
    const svc = new OnDemandService(
      firebase as never, polygon as never, null as never, null as never, null, null,
      null as never, fmp as never, secEdgar as never, delisted as never, null as never,
    );
    jest.spyOn(svc, "recordUsage").mockImplementation(() => undefined);
    jest.spyOn(svc as any, "computeFirstSyncTechnicals").mockResolvedValue(opts.technicals);
    return { svc, polygon, written };
  }

  it("technicals step failed: the stored 52-week range and indicators stay, re-anchored to the new price", async () => {
    const { svc, polygon } = harness({ technicals: {}, details: freshDetails });
    const doc = await svc.getCompany("NVDA");
    expect(doc!.price).toBe(149.3);
    expect(doc!.high52).toBe(243.37);
    expect(doc!.low52).toBe(124.5);
    expect(doc!.rsi14).toBe(41);
    expect(doc!.sma50).toBe(170);
    expect(doc!.pctFromHigh52).toBeCloseTo(-38.65, 1); // measured from 149.30, not the stored -34.3

    // The next read comes from memory and is the same doc, not a thin one.
    const again = await svc.getCompany("NVDA");
    expect(polygon.getTickerDetails).toHaveBeenCalledTimes(1);
    expect(again!.high52).toBe(243.37);
    expect(again!.low52).toBe(124.5);
  });

  it("technicals step worked: its fresh values win over the stored ones", async () => {
    const { svc } = harness({ technicals: { high52: 250, low52: 130, rsi14: 55 }, details: freshDetails });
    const doc = await svc.getCompany("NVDA");
    expect(doc!.high52).toBe(250);
    expect(doc!.low52).toBe(130);
    expect(doc!.rsi14).toBe(55);
  });

  it("profile fetch failed: the stored description and sector stay", async () => {
    const { svc } = harness({ technicals: { high52: 250, low52: 130 }, details: null });
    const doc = await svc.getCompany("NVDA");
    expect(doc!.description).toBe("Stored profile text");
    expect(doc!.sector).toBe("Technology");
    expect(doc!.price).toBe(149.3);
  });

  it("the Firestore write stays what the rebuild produced (merge:true); stored-only fields are not written back", async () => {
    const { svc, written } = harness({ technicals: {}, details: freshDetails });
    await svc.getCompany("NVDA");
    expect(written).toHaveLength(1);
    expect(written[0].options).toEqual({ merge: true });
    expect(written[0].data).not.toHaveProperty("sma50");
    expect(written[0].data).not.toHaveProperty("high52");
    expect(written[0].data.price).toBe(149.3);
  });
});
