import { PolygonService } from "../vendors/polygon/polygon.service";

/**
 * Financials mappers — pure functions + types shared by the on-demand
 * financials endpoint (src/live/ondemand.service.ts).
 *
 * The former FinancialsJob cron class (which swept the universe writing
 * `financials/{ticker}` docs) was retired along with the rest of the sync
 * machinery; only these vendor-response mappers remain.
 */

/** One row as returned by PolygonService.getFinancialStatements(). */
export type PolygonFinancialRow = Awaited<
  ReturnType<PolygonService["getFinancialStatements"]>
>[number];

/** One fiscal-year row — actuals only (Polygon annual financials). */
export interface AnnualFinancials {
  fiscalYear: string | null;
  endDate: string | null;
  filingDate: string | null;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  epsActual: number | null;
  netIncome: number | null;
}

export interface QuarterFinancials {
  fiscalPeriod: string | null;
  fiscalYear: string | null;
  endDate: string | null;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  epsActual: number | null;
  /** From earnings_events when a same-quarter estimate exists, else null. */
  epsEstimate: number | null;

  // ── Fields below come from the SAME vendor response that already served the
  // income statement. The balance-sheet and cash-flow panels were fabricated
  // while these were being fetched and discarded on every run. ──
  costOfRevenue: number | null;
  operatingExpenses: number | null;
  researchAndDevelopment: number | null;
  sellingGeneralAndAdministrative: number | null;
  incomeTaxExpense: number | null;
  dilutedAverageShares: number | null;

  totalAssets: number | null;
  currentAssets: number | null;
  totalLiabilities: number | null;
  currentLiabilities: number | null;
  equity: number | null;
  inventory: number | null;
  longTermDebt: number | null;

  netCashFlow: number | null;
  operatingCashFlow: number | null;
  investingCashFlow: number | null;
  financingCashFlow: number | null;

  /** Derived, because every consumer computed them differently or not at all. */
  grossMarginPct: number | null;
  operatingMarginPct: number | null;
  netMarginPct: number | null;
  currentRatio: number | null;
  filingDate: string | null;
}

/** Maps one quarterly Polygon financials row onto the doc shape `financials/{ticker}.quarters` stores. */
export function mapQuarterRow(
  r: PolygonFinancialRow,
  epsEstimate: number | null,
): QuarterFinancials {
  const inc = r.income;
  const bs = r.balanceSheet;
  const cf = r.cashFlow;
  const revenue = inc.revenues ?? null;
  const operatingIncome = inc.operating_income_loss ?? null;
  const netIncome = inc.net_income_loss ?? null;
  const grossProfit = inc.gross_profit ?? null;
  const currentAssets = bs.current_assets ?? null;
  const currentLiabilities = bs.current_liabilities ?? null;
  // Margins guard on revenue > 0 rather than just non-null: a quarter
  // with zero reported revenue would otherwise divide to Infinity.
  const pct = (num: number | null) =>
    num != null && revenue != null && revenue > 0
      ? Math.round((num / revenue) * 10000) / 100
      : null;
  return {
    fiscalPeriod: r.fiscalPeriod,
    fiscalYear: r.fiscalYear,
    endDate: r.endDate,
    filingDate: r.filingDate,
    revenue,
    grossProfit,
    operatingIncome,
    netIncome,
    epsActual: inc.diluted_earnings_per_share ?? null,
    epsEstimate,

    costOfRevenue: inc.cost_of_revenue ?? null,
    operatingExpenses: inc.operating_expenses ?? null,
    researchAndDevelopment: inc.research_and_development ?? null,
    sellingGeneralAndAdministrative:
      inc.selling_general_and_administrative_expenses ?? null,
    incomeTaxExpense: inc.income_tax_expense_benefit ?? null,
    dilutedAverageShares: inc.diluted_average_shares ?? null,

    totalAssets: bs.assets ?? null,
    currentAssets,
    totalLiabilities: bs.liabilities ?? null,
    currentLiabilities,
    equity: bs.equity ?? null,
    inventory: bs.inventory ?? null,
    longTermDebt: bs.long_term_debt ?? null,

    netCashFlow: cf.net_cash_flow ?? null,
    operatingCashFlow: cf.net_cash_flow_from_operating_activities ?? null,
    investingCashFlow: cf.net_cash_flow_from_investing_activities ?? null,
    financingCashFlow: cf.net_cash_flow_from_financing_activities ?? null,

    grossMarginPct: pct(grossProfit),
    operatingMarginPct: pct(operatingIncome),
    netMarginPct: pct(netIncome),
    currentRatio:
      currentAssets != null &&
      currentLiabilities != null &&
      currentLiabilities > 0
        ? Math.round((currentAssets / currentLiabilities) * 100) / 100
        : null,
  };
}

/** Maps one annual Polygon financials row onto the doc shape `financials/{ticker}.annual` stores. */
export function mapAnnualRow(r: PolygonFinancialRow): AnnualFinancials {
  return {
    fiscalYear: r.fiscalYear,
    endDate: r.endDate,
    filingDate: r.filingDate,
    revenue: r.income.revenues ?? null,
    grossProfit: r.income.gross_profit ?? null,
    operatingIncome: r.income.operating_income_loss ?? null,
    epsActual: r.income.diluted_earnings_per_share ?? null,
    netIncome: r.income.net_income_loss ?? null,
  };
}
