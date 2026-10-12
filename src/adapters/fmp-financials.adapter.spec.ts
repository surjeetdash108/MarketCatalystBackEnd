import type { FmpService, FmpStatementRow } from "../vendors/fmp/fmp.service";
import { mapAnnualRow, mapQuarterRow } from "../sync/financials.job";
import {
  FmpFinancialsAdapter,
  mapFmpStatements,
} from "./fmp-financials.adapter";
import { CompositeFinancialsAdapter } from "./market-data.adapters";
import type { CanonicalFinancialStatement, FinancialsAdapter } from "./types";

const stmt = (
  date: string,
  values: Record<string, number>,
  extra: Partial<FmpStatementRow> = {},
): FmpStatementRow => ({
  date,
  fiscalYear: date.slice(0, 4),
  period: "Q2",
  filingDate: "2025-08-13",
  reportedCurrency: "USD",
  values,
  ...extra,
});

// GAUZ 2025-Q2, trimmed from the live FMP response.
const gauzIncome = stmt("2025-06-30", {
  revenue: 20054000,
  costOfRevenue: 15768000,
  grossProfit: 4286000,
  operatingIncome: -12510000,
  netIncome: -10736000,
  eps: -11.4,
  epsDiluted: -11.4,
  weightedAverageShsOutDil: 936933,
});
const gauzBalance = stmt("2025-06-30", {
  totalAssets: 136806000,
  totalCurrentAssets: 46452000,
  totalCurrentLiabilities: 70874000,
  totalEquity: 17860000,
});
const gauzCashFlow = stmt("2025-06-30", {
  netCashProvidedByOperatingActivities: -3307000,
  netChangeInCash: 72000,
});

describe("mapFmpStatements", () => {
  it("maps FMP fields onto the canonical keys mapQuarterRow reads", () => {
    const { rows } = mapFmpStatements(
      [gauzIncome],
      [gauzBalance],
      [gauzCashFlow],
    );
    expect(rows).toHaveLength(1);
    const q = mapQuarterRow(rows[0], null);
    expect(q).toMatchObject({
      fiscalYear: "2025",
      fiscalPeriod: "Q2",
      endDate: "2025-06-30",
      revenue: 20054000,
      grossProfit: 4286000,
      netIncome: -10736000,
      epsActual: -11.4,
      dilutedAverageShares: 936933,
      totalAssets: 136806000,
      equity: 17860000,
      operatingCashFlow: -3307000,
      netCashFlow: 72000,
      grossMarginPct: 21.37,
      currentRatio: 0.66,
    });
  });

  it("uses diluted EPS, not FMP's basic eps, when they disagree", () => {
    // GAUZ 2024-Q2: eps -52 vs epsDiluted -24.8 on the same share count.
    const inc = stmt("2024-06-30", {
      revenue: 24409000,
      eps: -52,
      epsDiluted: -24.8,
    });
    const { rows } = mapFmpStatements([inc], [], []);
    expect(rows[0].income.diluted_earnings_per_share).toBe(-24.8);
    expect(mapQuarterRow(rows[0], null).epsActual).toBe(-24.8);
  });

  it("never surfaces FMP's generic eps, even when epsDiluted is missing", () => {
    const inc = stmt("2024-06-30", { revenue: 24409000, eps: -52 });
    const { rows } = mapFmpStatements([inc], [], []);
    expect(Object.values(rows[0].income)).not.toContain(-52);
    expect(mapQuarterRow(rows[0], null).epsActual).toBeNull();
    expect(mapAnnualRow(rows[0]).epsActual).toBeNull();
  });

  it("drops non-USD periods instead of storing them as dollars", () => {
    const twd = stmt(
      "2025-12-31",
      { revenue: 3848510949000 },
      { reportedCurrency: "TWD" },
    );
    const { rows, quarantined } = mapFmpStatements([twd, gauzIncome], [], []);
    expect(rows.map((r) => r.endDate)).toEqual(["2025-06-30"]);
    expect(quarantined).toEqual(["2025-12-31 (TWD)"]);
  });

  it("leaves balance sheet / cash flow empty when no period matches", () => {
    const { rows } = mapFmpStatements(
      [gauzIncome],
      [stmt("2025-03-31", {})],
      [],
    );
    expect(rows[0].balanceSheet).toEqual({});
    expect(rows[0].cashFlow).toEqual({});
    expect(mapQuarterRow(rows[0], null).totalAssets).toBeNull();
  });

  it("returns periods newest-first", () => {
    const older = stmt("2025-03-31", { revenue: 1 });
    const { rows } = mapFmpStatements([older, gauzIncome], [], []);
    expect(rows.map((r) => r.endDate)).toEqual(["2025-06-30", "2025-03-31"]);
  });
});

describe("FmpFinancialsAdapter", () => {
  const fakeFmp = () => {
    const calls: string[] = [];
    const fmp = {
      getFinancialStatement: jest.fn((kind: string) => {
        calls.push(kind);
        if (kind === "income-statement") return Promise.resolve([gauzIncome]);
        if (kind === "balance-sheet-statement")
          return Promise.reject(new Error("boom"));
        return Promise.resolve([gauzCashFlow]);
      }),
    } as unknown as FmpService;
    return { fmp, calls };
  };

  it("skips the balance-sheet and cash-flow calls when incomeOnly", async () => {
    const { fmp, calls } = fakeFmp();
    await new FmpFinancialsAdapter(fmp).fetchFinancialStatements(
      "GAUZ",
      "annual",
      8,
      {
        incomeOnly: true,
      },
    );
    expect(calls).toEqual(["income-statement"]);
  });

  it("degrades a failed secondary statement to a warning, not a failure", async () => {
    const { fmp } = fakeFmp();
    const res = await new FmpFinancialsAdapter(fmp).fetchFinancialStatements(
      "GAUZ",
      "quarterly",
      10,
    );
    expect(res.data).toHaveLength(1);
    expect(res.data[0].cashFlow.net_cash_flow).toBe(72000);
    expect(res.warnings.map((w) => w.code)).toContain("SUB_REQUEST_FAILED");
  });
});

describe("CompositeFinancialsAdapter (Polygon → FMP)", () => {
  const period: CanonicalFinancialStatement = {
    fiscalYear: "2025",
    fiscalPeriod: "Q2",
    endDate: "2025-06-30",
    filingDate: null,
    income: { revenues: 1 },
    balanceSheet: {},
    cashFlow: {},
  };
  const adapter = (
    name: string,
    impl: () => CanonicalFinancialStatement[],
  ): FinancialsAdapter => ({
    sourceName: name,
    requestDelayMs: 0,
    fetchIncomeStatements: jest.fn(),
    // .then() turns a throwing impl into a rejection, like a real vendor call.
    fetchFinancialStatements: jest.fn(() =>
      Promise.resolve().then(() => ({
        data: impl(),
        source: name,
        warnings: [],
      })),
    ),
  });

  it("falls back to FMP when Polygon returns zero periods (foreign filer)", async () => {
    const res = await new CompositeFinancialsAdapter(
      adapter("polygon", () => []),
      adapter("fmp", () => [period]),
    ).fetchFinancialStatements("GAUZ", "quarterly", 10);
    expect(res.source).toBe("fmp");
    expect(res.warnings[0].code).toBe("FALLBACK_USED");
  });

  it("falls back to FMP when Polygon throws (410 brownout)", async () => {
    const res = await new CompositeFinancialsAdapter(
      adapter("polygon", () => {
        throw new Error("GET /vX/reference/financials -> 410: GONE");
      }),
      adapter("fmp", () => [period]),
    ).fetchFinancialStatements("AAPL", "quarterly", 10);
    expect(res.source).toBe("fmp");
  });

  it("does not call FMP when Polygon has data", async () => {
    let fmpCalls = 0;
    const res = await new CompositeFinancialsAdapter(
      adapter("polygon", () => [period]),
      adapter("fmp", () => {
        fmpCalls++;
        return [period];
      }),
    ).fetchFinancialStatements("AAPL", "quarterly", 10);
    expect(res.source).toBe("polygon");
    expect(fmpCalls).toBe(0);
  });

  it("returns a benign empty when both vendors have nothing", async () => {
    const res = await new CompositeFinancialsAdapter(
      adapter("polygon", () => []),
      adapter("fmp", () => []),
    ).fetchFinancialStatements("SPY", "quarterly", 10);
    expect(res.data).toEqual([]);
  });
});
