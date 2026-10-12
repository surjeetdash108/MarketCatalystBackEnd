import type { FmpService, FmpStatementRow } from "../vendors/fmp/fmp.service";
import type {
  AdapterResult,
  AdapterWarning,
  CanonicalFinancialStatement,
  CanonicalIncomeStatement,
  FinancialsAdapter,
  FinancialsTimeframe,
} from "./types";

/**
 * FMP financial statements, mapped onto the canonical (Polygon/XBRL-keyed)
 * statement vocabulary so mapQuarterRow/mapAnnualRow consume either vendor
 * unchanged.
 *
 * Why FMP: Polygon's /vX/reference/financials only covers 10-Q/10-K filers, so
 * foreign private issuers (20-F/6-K — GAUZ, many ADRs) come back as a 200 with
 * zero periods, and the endpoint itself is being sunset. FMP serves the same
 * statements for those names.
 *
 * FMP splits the statements across three endpoints; the income statement
 * defines the periods and the other two are joined to it on period end date.
 */

/** canonical key → FMP field. Only keys some consumer actually reads. */
const INCOME_KEYS: Record<string, string> = {
  revenues: "revenue",
  cost_of_revenue: "costOfRevenue",
  gross_profit: "grossProfit",
  operating_expenses: "operatingExpenses",
  operating_income_loss: "operatingIncome",
  research_and_development: "researchAndDevelopmentExpenses",
  selling_general_and_administrative_expenses:
    "sellingGeneralAndAdministrativeExpenses",
  income_tax_expense_benefit: "incomeTaxExpense",
  net_income_loss: "netIncome",
  // EPS is epsDiluted ONLY. FMP's generic `eps` is deliberately not mapped
  // (not even to basic_earnings_per_share): it is wrong on some rows — GAUZ
  // 2024-Q2 has eps -52 vs epsDiluted -24.8 on the SAME share count, and only
  // the diluted figure reconciles with netIncome ÷ shares. Leaving it out means
  // no `diluted ?? basic` fallback anywhere can ever surface it; a period with
  // no epsDiluted shows no EPS rather than a wrong one.
  diluted_earnings_per_share: "epsDiluted",
  basic_average_shares: "weightedAverageShsOut",
  diluted_average_shares: "weightedAverageShsOutDil",
};

const BALANCE_SHEET_KEYS: Record<string, string> = {
  assets: "totalAssets",
  current_assets: "totalCurrentAssets",
  liabilities: "totalLiabilities",
  current_liabilities: "totalCurrentLiabilities",
  // Total equity incl. minority interest — same basis as Polygon's `equity`.
  equity: "totalEquity",
  inventory: "inventory",
  long_term_debt: "longTermDebt",
};

const CASH_FLOW_KEYS: Record<string, string> = {
  net_cash_flow: "netChangeInCash",
  net_cash_flow_from_operating_activities:
    "netCashProvidedByOperatingActivities",
  net_cash_flow_from_investing_activities:
    "netCashProvidedByInvestingActivities",
  net_cash_flow_from_financing_activities:
    "netCashProvidedByFinancingActivities",
};

function pick(
  row: FmpStatementRow | undefined,
  keys: Record<string, string>,
): Record<string, number | null> {
  if (!row) return {};
  return Object.fromEntries(
    Object.entries(keys).map(([canonical, fmp]) => [
      canonical,
      row.values[fmp] ?? null,
    ]),
  );
}

/**
 * A period explicitly reported in a non-USD currency. Every consumer assumes
 * USD (TSM reports TWD — its revenue would chart ~32× too high), so such
 * periods are dropped. Absent currency passes, mirroring Polygon's
 * conservative nonUsdCurrencyUnit check.
 */
function nonUsdCurrency(row: FmpStatementRow): string | null {
  const c = row.reportedCurrency?.trim().toUpperCase();
  return c && /^[A-Z]{3}$/.test(c) && c !== "USD" ? c : null;
}

/**
 * Join FMP's three statement series into canonical periods (newest first).
 * Periods without an income statement are not emitted — the income statement
 * is what every consumer keys on.
 */
export function mapFmpStatements(
  income: FmpStatementRow[],
  balanceSheet: FmpStatementRow[],
  cashFlow: FmpStatementRow[],
): { rows: CanonicalFinancialStatement[]; quarantined: string[] } {
  const bsByDate = new Map(balanceSheet.map((r) => [r.date, r]));
  const cfByDate = new Map(cashFlow.map((r) => [r.date, r]));
  const quarantined: string[] = [];
  const rows: CanonicalFinancialStatement[] = [];
  for (const inc of [...income].sort((a, b) => b.date.localeCompare(a.date))) {
    const currency = nonUsdCurrency(inc);
    if (currency) {
      quarantined.push(`${inc.date} (${currency})`);
      continue;
    }
    rows.push({
      fiscalYear: inc.fiscalYear,
      fiscalPeriod: inc.period,
      endDate: inc.date,
      filingDate: inc.filingDate,
      income: pick(inc, INCOME_KEYS),
      balanceSheet: pick(bsByDate.get(inc.date), BALANCE_SHEET_KEYS),
      cashFlow: pick(cfByDate.get(inc.date), CASH_FLOW_KEYS),
    });
  }
  return { rows, quarantined };
}

export class FmpFinancialsAdapter implements FinancialsAdapter {
  readonly sourceName = "fmp";
  // FmpService.pace() already spaces every request, so callers add no delay.
  readonly requestDelayMs = 0;

  constructor(private readonly fmp: FmpService) {}

  async fetchFinancialStatements(
    ticker: string,
    timeframe: FinancialsTimeframe,
    limit: number,
    opts?: { incomeOnly?: boolean },
  ): Promise<AdapterResult<CanonicalFinancialStatement[]>> {
    const period = timeframe === "annual" ? "annual" : "quarter";
    const warnings: AdapterWarning[] = [];
    const income = await this.fmp.getFinancialStatement(
      "income-statement",
      ticker,
      period,
      limit,
    );

    let balanceSheet: FmpStatementRow[] = [];
    let cashFlow: FmpStatementRow[] = [];
    if (income.length > 0 && !opts?.incomeOnly) {
      // Secondary statements degrade to empty maps rather than failing the
      // whole period set — the Sales/EPS charts need only the income statement.
      const [bs, cf] = await Promise.allSettled([
        this.fmp.getFinancialStatement(
          "balance-sheet-statement",
          ticker,
          period,
          limit,
        ),
        this.fmp.getFinancialStatement(
          "cash-flow-statement",
          ticker,
          period,
          limit,
        ),
      ]);
      if (bs.status === "fulfilled") balanceSheet = bs.value;
      else
        warnings.push({
          code: "SUB_REQUEST_FAILED",
          field: "balanceSheet",
          message: `FMP balance sheet for ${ticker} failed: ${(bs.reason as Error)?.message}`,
        });
      if (cf.status === "fulfilled") cashFlow = cf.value;
      else
        warnings.push({
          code: "SUB_REQUEST_FAILED",
          field: "cashFlow",
          message: `FMP cash flow for ${ticker} failed: ${(cf.reason as Error)?.message}`,
        });
    }

    const { rows, quarantined } = mapFmpStatements(
      income,
      balanceSheet,
      cashFlow,
    );
    if (quarantined.length > 0) {
      warnings.push({
        code: "DATA_QUARANTINED",
        message: `Dropped ${quarantined.length} non-USD FMP period(s) for ${ticker}: ${quarantined.join(", ")}`,
      });
    }
    return { data: rows, source: this.sourceName, warnings };
  }

  async fetchIncomeStatements(
    ticker: string,
    timeframe: string,
    limit: number,
  ): Promise<AdapterResult<CanonicalIncomeStatement[]>> {
    const res = await this.fetchFinancialStatements(
      ticker,
      timeframe === "annual" ? "annual" : "quarterly",
      limit,
      { incomeOnly: true },
    );
    return {
      ...res,
      data: res.data.map((r) => ({
        fiscalYear: r.fiscalYear,
        revenue: r.income.revenues ?? null,
        costOfRevenue: r.income.cost_of_revenue ?? null,
        grossProfit: r.income.gross_profit ?? null,
        dilutedEps: r.income.diluted_earnings_per_share ?? null,
      })),
    };
  }
}
