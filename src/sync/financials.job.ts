import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { activeUniverse } from "../common/ticker-universe";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { EARNINGS_ESTIMATES_ADAPTER } from "../adapters/types";
import type { EarningsEstimatesAdapter } from "../adapters/earnings-estimates.adapter";

/**
 * 10-quarter quarterly financials → `financials/{ticker}` (delivery-plan R29).
 *
 * Replaces the fabricated income-statement / EPS-history that Stock Detail and
 * the Earnings Hub rendered via earnHistory()/earnIncome(). Source is Polygon's
 * /vX/reference/financials (quarterly) — verified 10 real quarters available on
 * the current plan. Where a synced earnings_events estimate exists for the same
 * quarter, it is joined so the EPS chart can show estimate-vs-actual instead of
 * an invented surprise.
 *
 * A separate collection (not merged onto `companies`) because it is an ARRAY of
 * quarters per ticker, not a flat field set, and only Stock Detail / Earnings
 * read it — keeping it out of the hot `companies` doc avoids bloating every
 * screen's company read.
 */

const JOB_NAME = "financials";
// Per-run cursor batch. Configurable so a backfill (or a larger universe) can be
// covered in fewer runs without waiting days for the 40/run cursor to rotate.
// Keep it small enough that one run finishes inside the Cloud Run request timeout
// (900s): ~2.5s/ticker, so 150 ≈ 6min. Default 40 preserves the original cadence.
const BATCH_SIZE = Number(process.env.FINANCIALS_BATCH_SIZE) || 40;
const QUARTERS = 10;
const ANNUAL_YEARS = 8;
const DELAY_MS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

@Injectable()
export class FinancialsJob implements OnModuleInit {
  private readonly logger = new Logger(FinancialsJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    // Optional forward-estimate source (FMP). null when EARNINGS_ESTIMATES_SOURCE
    // = "none" (default) — the doc then carries no `annualEstimates` field.
    @Inject(EARNINGS_ESTIMATES_ADAPTER)
    private readonly estimates: EarningsEstimatesAdapter | null,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["financials"],
      cronExpression: "45 4 * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  /**
   * epsEstimate keyed by `TICKER_YYYY-MM-DD` (report date), sourced from the
   * synced earnings_events (Polygon) collection — sparse, since Polygon carries
   * no forward EPS estimates, so the estimate line degrades where none exists.
   */
  private async estimatesFor(tickers: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();

    // Polygon-derived earnings_events already in Firestore.
    const snaps = await Promise.all(
      tickers.map((t) =>
        this.firebase.firestore
          .collection("earnings_events")
          .where("ticker", "==", t)
          .get(),
      ),
    );
    for (const snap of snaps) {
      for (const d of snap.docs) {
        const data = d.data();
        if (data.epsEstimate != null && data.ticker && data.date) {
          out.set(`${data.ticker}_${data.date}`, data.epsEstimate);
        }
      }
    }

    return out;
  }

  /** Nearest estimate to a quarter's period-end date, within a ~90-day window. */
  private matchEstimate(
    estimates: Map<string, number>,
    ticker: string,
    endDate: string | null,
  ): number | null {
    if (!endDate) return null;
    const target = new Date(`${endDate}T00:00:00Z`).getTime();
    let best: { v: number; gap: number } | null = null;
    for (const [key, v] of estimates) {
      if (!key.startsWith(`${ticker}_`)) continue;
      const dateStr = key.slice(ticker.length + 1);
      const gap =
        Math.abs(new Date(`${dateStr}T00:00:00Z`).getTime() - target) /
        86_400_000;
      // Report date follows the fiscal period end by weeks; 90d is generous.
      if (gap <= 90 && (!best || gap < best.gap)) best = { v, gap };
    }
    return best?.v ?? null;
  }

  async run() {
    try {
      const universe = await activeUniverse(this.firebase.firestore);
      if (universe.length === 0) {
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { count: 0, note: "no active tickers yet" };
      }
      // Batch never larger than the active universe, so a small
      // universe is fully covered in one premarket run.
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from(
        { length: Math.min(BATCH_SIZE, universe.length) },
        (_, i) => universe[(cursor + i) % universe.length],
      );
      const estimates = await this.estimatesFor(batch);

      // Existing docs for this batch — used to PRESERVE FMP-derived fields when a
      // fetch comes back empty (FMP can silently return empty under load). Without
      // this, a throttled run would overwrite good annualEstimates/epsEstimate with
      // nulls and coverage would oscillate instead of converging.
      const prevSnap = await this.firebase.firestore.getAll(
        ...batch.map((t) =>
          this.firebase.firestore.collection("financials").doc(t),
        ),
      );
      const prevById = new Map(
        prevSnap.filter((s) => s.exists).map((s) => [s.id, s.data() ?? {}]),
      );

      const docs: { id: string; data: Record<string, unknown> }[] = [];
      let failed = 0;
      for (const ticker of batch) {
        try {
          const rows = await this.polygon.getFinancialStatements(
            ticker,
            "quarterly",
            QUARTERS,
          );
          if (rows.length === 0) {
            failed++;
            continue;
          }
          const prev = prevById.get(ticker) as
            | { quarters?: QuarterFinancials[]; annualEstimates?: unknown[] }
            | undefined;
          // Full EPS-estimate history from the optional adapter (FMP) fills
          // %surp for EVERY quarter; the earnings_events match is the fallback
          // (only ~180 days) when the adapter is off or has no coverage. A prior
          // stored estimate is the last resort so a transient empty FMP response
          // never wipes an already-known %surp.
          const fmpQ = this.estimates
            ? await this.estimates.getQuarterlyEstimates(ticker)
            : null;
          const prevEpsByEnd = new Map(
            (prev?.quarters ?? []).map((q) => [q.endDate, q.epsEstimate]),
          );
          const quarters: QuarterFinancials[] = rows.map((r) =>
            mapQuarterRow(
              r,
              fmpQ?.epsEstimateFor(r.endDate) ??
                this.matchEstimate(estimates, ticker, r.endDate) ??
                prevEpsByEnd.get(r.endDate) ??
                null,
            ),
          );
          // ── Annual (fiscal-year) history — actuals only, Polygon ──────────
          // Same endpoint, timeframe=annual. Drives the Yearly tab's EPS +
          // Sales columns. Forward analyst estimates are NOT sourced here
          // (no estimates vendor is wired) — this is reported actuals only.
          let annual: AnnualFinancials[] = [];
          try {
            const yr = await this.polygon.getFinancialStatements(
              ticker,
              "annual",
              ANNUAL_YEARS,
            );
            annual = yr.map(mapAnnualRow);
          } catch (err) {
            this.logger.warn(
              `annual financials failed for ${ticker}: ${err.message}`,
            );
          }

          // Forward annual estimates (the `*YYYY` rows) — only when the optional
          // estimates adapter is configured; empty array otherwise. If FMP
          // returns nothing this run (transient empty), keep the previously
          // stored estimates rather than wiping them to [].
          let annualEstimates: unknown[] = this.estimates
            ? await this.estimates.getForwardAnnual(ticker).catch(() => [])
            : [];
          if (
            annualEstimates.length === 0 &&
            Array.isArray(prev?.annualEstimates) &&
            prev.annualEstimates.length > 0
          ) {
            annualEstimates = prev.annualEstimates;
          }
          docs.push({
            id: ticker,
            data: {
              ticker,
              quarters,
              annual,
              annualEstimates,
              updatedAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          this.logger.error(`financials failed for ${ticker}: ${err.message}`);
          failed++;
        }
        await sleep(DELAY_MS);
      }

      await chunkedBatchSet(this.firebase.firestore, "financials", docs);
      await this.meta.setCursor(
        JOB_NAME,
        (cursor + BATCH_SIZE) % universe.length,
      );
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      return { written: docs.length, failed };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
