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
      process.env.SEC_USER_AGENT = "Example Operator ops@example.com";
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

    it("SEC_USER_AGENT unset: no SEC fallback is attempted", async () => {
      delete process.env.SEC_USER_AGENT;
      const cik = jest.spyOn(cikMap, "getTickerToCik");
      const getSubmissions = jest.fn();
      const { svc } = make({
        fmp: { getInsiderTrades: jest.fn().mockRejectedValue(new Error("503")) },
        sec: { getSubmissions, getForm4Transactions: jest.fn() },
      });
      await svc.getInsiderTransactions("STRL").catch(() => []);
      expect(cik).not.toHaveBeenCalled();
      expect(getSubmissions).not.toHaveBeenCalled();
    });

    it("serves a fresh stored doc without calling any vendor", async () => {
      const { svc, fmp } = make({
        seed: { "insider_by_ticker/AAPL": { rows: [{ id: "x", ticker: "AAPL" }], updatedAt: new Date().toISOString() } },
      });
      await expect(svc.getInsiderTransactions("AAPL")).resolves.toEqual([{ id: "x", ticker: "AAPL" }]);
      expect(fmp.getInsiderTrades).not.toHaveBeenCalled();
    });
  });

  describe("market-wide insider feed (FMP open-market buys/sells, US only)", () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const row = (symbol: string, type: string, filed: string, traded: string, price: number | null = 25) => ({
      symbol, transactionType: type, filingDate: filed, transactionDate: traded,
      reportingCik: "1", reportingName: "Insider", typeOfOwner: "director",
      acquisitionOrDisposition: type.startsWith("P") ? "A" : "D", securitiesTransacted: 1000, price,
    });

    it("keeps US, priced, in-window trades with app-form tickers, newest first", async () => {
      const getMarketInsiderTrades = jest.fn(async (type: string, page: number) => {
        if (page > 0) return [];
        return type === "P-Purchase"
          ? [
              row("BRK-B", "P-Purchase", daysAgo(1), daysAgo(2)),
              row("SAP.DE", "P-Purchase", daysAgo(1), daysAgo(1)), // foreign
              row("AAPL", "P-Purchase", daysAgo(3), "2020-03-05"), // late filing of an old trade
              row("MSFT", "P-Purchase", daysAgo(1), daysAgo(1), null), // unpriced
            ]
          : [row("NVDA", "S-Sale", daysAgo(0), daysAgo(0)), row("TSLA", "S-Sale", daysAgo(95), daysAgo(95))]; // past 90d
      });
      const { svc } = make({ fmp: { getMarketInsiderTrades } });
      const rows = await svc.getMarketWideInsiderTransactions();
      expect(rows.map((r) => [r.ticker, r.transactionCode])).toEqual([["NVDA", "S"], ["BRK.B", "P"]]);
      expect(rows.every((r) => !("url" in r))).toBe(true);

      // Cached: a second call makes no vendor requests.
      getMarketInsiderTrades.mockClear();
      await svc.getMarketWideInsiderTransactions();
      expect(getMarketInsiderTrades).not.toHaveBeenCalled();
    });

    it("returns [] when FMP fails cold, so the controller falls back to SEC", async () => {
      const { svc } = make({ fmp: { getMarketInsiderTrades: jest.fn().mockRejectedValue(new Error("503")) } });
      await expect(svc.getMarketWideInsiderTransactions()).resolves.toEqual([]);
    });
  });

  describe("market-wide analyst merge", () => {
    it("replaces a carried-forward target with the same-day post, keeping the old one as previous", async () => {
      const getLatestGrades = jest.fn(async () => []);
      const getLatestPriceTargets = jest.fn(async (page: number) => page > 0 ? [] : [
        { symbol: "ISRG", publishedDate: "2026-10-21T12:00:00.000Z", analystCompany: "Evercore ISI", priceTarget: 385,
          newsTitle: "Evercore ISI lowers Intuitive Surgical price target to $385 from $400" },
      ]);
      const { svc } = make({ fmp: { getLatestGrades, getLatestPriceTargets } });
      const base = [{ id: "ISRG", ticker: "ISRG", consensus: "Buy", recentGrades: [
        { date: "2026-10-21", firm: "Evercore", action: "maintain", newGrade: "Outperform", priceTarget: 430, priceTargetDate: "2026-07-20" },
      ] }];
      const [isrg] = await svc.getMarketWideAnalystActions(base);
      expect((isrg as { recentGrades: unknown[] }).recentGrades).toEqual([
        expect.objectContaining({ firm: "Evercore", priceTarget: 385, previousPriceTarget: 400, priceTargetDate: "2026-10-21" }),
      ]);
    });

    const consensus = {
      consensus: "Buy", strongBuy: 1, buy: 10, hold: 3, sell: 0, strongSell: 0,
      priceTargetConsensus: 150, priceTargetHigh: 200, priceTargetLow: 100, priceTargetMedian: 150,
      ptAvgLastMonth: null, ptAvgLastQuarter: null, ptAvgLastYear: null, recentGrades: [],
    };

    it("uses FMP's publish date, same-firm targets, and REAL consensus for untracked stocks", async () => {
      const getLatestGrades = jest.fn(async (page: number) => page > 0 ? [] : [
        { symbol: "AAPL", publishedDate: "2026-10-18T13:00:00.000Z", gradingCompany: "Jefferies", previousGrade: "Hold", newGrade: "Buy", action: "upgrade" },
        { symbol: "CRWV", publishedDate: "2026-10-19T20:51:41.000Z", gradingCompany: "Exane BNP Paribas", previousGrade: "Outperform", newGrade: "Outperform", action: "hold" },
        { symbol: "NOCOV", publishedDate: "2026-10-19T10:00:00.000Z", gradingCompany: "Citi", newGrade: "Buy", action: "upgrade" },
        { symbol: "NRDXF.F", publishedDate: "2026-10-19T10:00:00.000Z", gradingCompany: "Citi", newGrade: "Buy", action: "upgrade" },
        { symbol: "ESLOY", publishedDate: "2026-10-19T10:00:00.000Z", gradingCompany: "Citi", newGrade: "Buy", action: "upgrade" },
        { symbol: "ONEAN", publishedDate: "2026-10-19T10:00:00.000Z", gradingCompany: "Citi", newGrade: "Buy", action: "upgrade" },
      ]);
      const getLatestPriceTargets = jest.fn(async (page: number) => page > 0 ? [] : [
        { symbol: "AAPL", publishedDate: "2026-10-18T13:05:00.000Z", analystCompany: "Jefferies", priceTarget: 300 },
        { symbol: "AAPL", publishedDate: "2026-10-18T09:00:00.000Z", analystCompany: "Morgan Stanley", priceTarget: 999 },
      ]);
      const ratings = { sourceName: "fmp", getConsensus: jest.fn(async (sym: string) =>
        sym === "CRWV" ? consensus : sym === "ONEAN" ? { ...consensus, strongBuy: 0, buy: 1, hold: 0 } : null) };
      const { svc } = make({ fmp: { getLatestGrades, getLatestPriceTargets }, ratings });
      const base = [{ id: "AAPL", ticker: "AAPL", consensus: "Buy", recentGrades: [{ date: "2026-10-01", firm: "UBS", action: "maintain" }] }];
      const out = await svc.getMarketWideAnalystActions(base);
      const by = new Map(out.map((d) => [d.ticker, d]));

      const aapl = by.get("AAPL") as { recentGrades: Array<Record<string, unknown>> };
      expect(aapl.recentGrades[0]).toMatchObject({ date: "2026-10-18", firm: "Jefferies", priceTarget: 300 });
      // A target post with no grade row is its own row (a pure PT change).
      expect(aapl.recentGrades).toHaveLength(3);
      expect(aapl.recentGrades.find((g) => g.firm === "Morgan Stanley")).toMatchObject({ date: "2026-10-18", priceTarget: 999 });
      // Untracked with an FMP consensus: the REAL counts, not one firm's rating.
      expect(by.get("CRWV")).toMatchObject({ consensus: "Buy", buy: 10, hold: 3, priceTargetConsensus: 150 });
      // No FMP consensus → left out; foreign symbol → never considered.
      expect(by.has("NOCOV")).toBe(false);
      expect([...by.keys()].some((k) => String(k).includes("NRDXF"))).toBe(false);
      expect(ratings.getConsensus).not.toHaveBeenCalledWith(expect.stringContaining("NRDXF"));
      // A one-analyst "consensus" is not shown; foreign OTC lines are not looked up.
      expect(by.has("ONEAN")).toBe(false);
      expect(ratings.getConsensus).not.toHaveBeenCalledWith("ESLOY");
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
