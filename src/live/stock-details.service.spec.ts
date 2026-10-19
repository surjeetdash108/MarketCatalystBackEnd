import { StockDetailsService } from "./stock-details.service";
import { filedThirteenFQuarters } from "../vendors/fmp/fmp.service";
import * as cikMap from "../common/sec-cik-map.util";

/** In-memory stand-in for the two Firestore calls the service makes. */
function fakeFirestore(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map(Object.entries(seed));
  const writes: string[] = [];
  return {
    store,
    writes,
    firebase: {
      firestore: {
        collection: (c: string) => ({
          doc: (id: string) => ({
            get: async () => ({ data: () => store.get(`${c}/${id}`) }),
            set: async (d: Record<string, unknown>) => {
              writes.push(`${c}/${id}`);
              store.set(`${c}/${id}`, { ...(store.get(`${c}/${id}`) ?? {}), ...d });
            },
          }),
        }),
      },
    },
  };
}

const today = new Date().toISOString().slice(0, 10);
const yearsAgo = (n: number) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
};
const fmpTrade = (date: string, i = 0) => ({
  transactionDate: date,
  filingDate: date,
  reportingCik: `c${i}`,
  reportingName: `Insider ${i}`,
  typeOfOwner: "director",
  transactionType: "S-Sale",
  acquisitionOrDisposition: "D",
  securitiesTransacted: 100 + i,
  price: 10,
});

function make(opts: {
  fmp?: Record<string, unknown>;
  polygon?: Record<string, unknown>;
  sec?: Record<string, unknown>;
  ratings?: { sourceName: string; getConsensus: jest.Mock } | null;
  seed?: Record<string, Record<string, unknown>>;
} = {}) {
  const fs = fakeFirestore(opts.seed);
  const fmp = { enabled: true, getInsiderTrades: jest.fn().mockResolvedValue([]), ...opts.fmp };
  const polygon = { getShortInterest: jest.fn().mockResolvedValue(null), ...opts.polygon };
  const sec = { getSubmissions: jest.fn(), getForm4Transactions: jest.fn(), ...opts.sec };
  const svc = new StockDetailsService(
    fs.firebase as never, fmp as never, polygon as never, sec as never, (opts.ratings ?? null) as never,
  );
  return { svc, fs, fmp, polygon, sec };
}

describe("StockDetailsService", () => {
  afterEach(() => jest.restoreAllMocks());

  describe("insider transactions (FMP primary, SEC backup)", () => {
    it("walks FMP pages newest-first, stops at the lookback cutoff, and caches the result", async () => {
      const page0 = Array.from({ length: 100 }, (_, i) => fmpTrade(today, i));
      const page1 = [fmpTrade(yearsAgo(3), 1), fmpTrade(yearsAgo(11), 2)]; // short page, last one past cutoff
      const getInsiderTrades = jest.fn((_s: string, page: number) =>
        Promise.resolve(page === 0 ? page0 : page === 1 ? page1 : []));
      const { svc, fs, sec } = make({ fmp: { getInsiderTrades } });

      const rows = await svc.getInsiderTransactions("BRK.B");
      expect(getInsiderTrades.mock.calls[0][0]).toBe("BRK-B"); // FMP's class-share spelling
      expect(rows).toHaveLength(101); // the 11-year-old trade is outside the window
      expect(rows.every((r) => r.vendor === "fmp" && r.ticker === "BRK.B")).toBe(true);
      expect(rows[0].transactionDate >= rows[rows.length - 1].transactionDate).toBe(true);
      expect(sec.getSubmissions).not.toHaveBeenCalled();
      expect(fs.store.get("insider_by_ticker/BRK.B")).toMatchObject({ source: "fmp" });

      // Second call: served from cache, no vendor traffic.
      getInsiderTrades.mockClear();
      await svc.getInsiderTransactions("BRK.B");
      expect(getInsiderTrades).not.toHaveBeenCalled();
    });

    it("falls back to SEC Form 4 when FMP errors", async () => {
      jest.spyOn(cikMap, "getTickerToCik").mockResolvedValue(new Map([["STRL", "874238"]]));
      const { svc, fs } = make({
        fmp: { getInsiderTrades: jest.fn().mockRejectedValue(new Error("503")) },
        sec: {
          getSubmissions: jest.fn().mockResolvedValue({
            recentFilings: [
              { form: "4", accessionNumber: "acc1", filingDate: "2026-10-07" },
              { form: "8-K", accessionNumber: "acc2", filingDate: "2026-10-01" },
            ],
          }),
          getForm4Transactions: jest.fn().mockResolvedValue({
            issuer: { ticker: "STRL" },
            owner: { name: "Hargis", isOfficer: true, officerTitle: "GC" },
            transactions: [{
              transactionDate: { value: "2026-10-05" },
              transactionCoding: { transactionCode: "A" },
              transactionAmounts: { transactionShares: { value: "1000" }, transactionAcquiredDisposedCode: { value: "A" } },
            }],
          }),
        },
      });
      const rows = await svc.getInsiderTransactions("STRL");
      expect(rows).toEqual([expect.objectContaining({ id: "acc1_0", ownerName: "Hargis", shares: 1000, vendor: "sec" })]);
      expect(fs.store.get("insider_by_ticker/STRL")).toMatchObject({ source: "sec" });
    });

    it("serves a fresh stored doc without calling any vendor", async () => {
      const { svc, fmp } = make({
        seed: { "insider_by_ticker/AAPL": { rows: [{ id: "x", ticker: "AAPL" }], updatedAt: new Date().toISOString() } },
      });
      await expect(svc.getInsiderTransactions("AAPL")).resolves.toEqual([{ id: "x", ticker: "AAPL" }]);
      expect(fmp.getInsiderTrades).not.toHaveBeenCalled();
    });
  });

  describe("analyst consensus", () => {
    const consensus = {
      consensus: "Buy", strongBuy: 0, buy: 8, hold: 2, sell: 0, strongSell: 0,
      priceTargetConsensus: 777.8, priceTargetHigh: 950, priceTargetLow: 700, priceTargetMedian: 742,
      ptAvgLastMonth: null, ptAvgLastQuarter: null, ptAvgLastYear: null, recentGrades: [],
    };

    it("fetches from FMP on demand when no doc is stored, in the sweep's doc shape", async () => {
      const ratings = { sourceName: "fmp", getConsensus: jest.fn().mockResolvedValue(consensus) };
      const { svc, fs } = make({ ratings });
      await expect(svc.getAnalystConsensus("STRL")).resolves.toMatchObject({ ticker: "STRL", consensus: "Buy", buy: 8, source: "fmp" });
      expect(fs.writes).toEqual(["analyst_actions/STRL"]);
    });

    it("keeps serving a stale stored doc when FMP has nothing or fails", async () => {
      const stale = { ticker: "STRL", consensus: "Hold", updatedAt: "2020-01-01T00:00:00Z" };
      for (const getConsensus of [jest.fn().mockResolvedValue(null), jest.fn().mockRejectedValue(new Error("503"))]) {
        const { svc } = make({ ratings: { sourceName: "fmp", getConsensus }, seed: { "analyst_actions/STRL": stale } });
        await expect(svc.getAnalystConsensus("STRL")).resolves.toEqual(stale);
      }
    });
  });

  describe("ownership", () => {
    it("combines FMP's 13F rollup + top holders with Polygon short interest, for a fully-filed quarter", async () => {
      const [q] = filedThirteenFQuarters(1);
      const getInstitutionalOwnership = jest.fn().mockResolvedValue({
        ownershipPercent: 86.8, investorsHolding: 913, investorsHoldingChange: 182, numberOf13Fshares: 26_610_153,
      });
      const get13FExtractAnalytics = jest.fn().mockResolvedValue([
        { investorName: "VANGUARD", cik: "2", sharesNumber: 1_332_730, ownership: 4.3 },
        { investorName: "BLACKROCK, INC.", cik: "1", sharesNumber: 3_233_353, ownership: 10.5, changeInSharesNumber: -750_930 },
        { investorName: "CLOSED OUT", cik: "3", sharesNumber: 0 },
      ]);
      const short = { settlementDate: "2026-09-30", shortInterest: 1_161_560, avgDailyVolume: 531_455, daysToCover: 2.19 };
      const { svc } = make({
        fmp: { getInstitutionalOwnership, get13FExtractAnalytics },
        polygon: { getShortInterest: jest.fn().mockResolvedValue(short) },
      });
      const doc = await svc.getOwnership("STRL");
      expect(getInstitutionalOwnership).toHaveBeenCalledWith("STRL", q.year, q.quarter);
      expect(doc).toMatchObject({
        institutional: { asOf: `${q.year} Q${q.quarter}`, ownershipPct: 86.8, holders: 913, holdersChange: 182 },
        shortInterest: short,
        sources: { institutional: "fmp", shortInterest: "polygon" },
      });
      expect((doc!.topHolders as Array<{ name: string }>).map((h) => h.name)).toEqual(["BLACKROCK, INC.", "VANGUARD"]);
    });

    it("still answers when one vendor fails, and caches nothing when both do", async () => {
      const shortOnly = make({
        fmp: { getInstitutionalOwnership: jest.fn().mockRejectedValue(new Error("fmp down")) },
        polygon: { getShortInterest: jest.fn().mockResolvedValue({ settlementDate: "d", shortInterest: 1, avgDailyVolume: null, daysToCover: null }) },
      });
      await expect(shortOnly.svc.getOwnership("X")).resolves.toMatchObject({ institutional: null, shortInterest: { shortInterest: 1 } });

      const none = make({
        fmp: { getInstitutionalOwnership: jest.fn().mockResolvedValue(null) },
        polygon: { getShortInterest: jest.fn().mockRejectedValue(new Error("polygon down")) },
      });
      await expect(none.svc.getOwnership("X")).resolves.toBeNull();
      expect(none.fs.writes).toEqual([]);
    });
  });
});

describe("filedThirteenFQuarters", () => {
  it("skips a quarter until its 13F deadline (45 days after quarter end) has passed", () => {
    const at = (d: string) => filedThirteenFQuarters(1, new Date(`${d}T12:00:00Z`))[0];
    expect(at("2026-10-19")).toEqual({ year: 2026, quarter: 2 }); // Q3 still filing (87 of ~913 in)
    expect(at("2026-11-13")).toEqual({ year: 2026, quarter: 2 });
    expect(at("2026-11-14")).toEqual({ year: 2026, quarter: 3 }); // Sep 30 + 45 days
    expect(at("2026-01-10")).toEqual({ year: 2025, quarter: 3 }); // year boundary
  });
});
