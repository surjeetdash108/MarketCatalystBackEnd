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
  /** FMP's reported EPS actual (consensus/non-GAAP basis), matched to this
   * quarter. Use THIS — not `epsActual` (Polygon GAAP diluted) — for beat/miss
   * vs `epsEstimateReported`, so heavy-SBC / one-off-tax names don't show bogus
   * surprises. Null when FMP has no surprise row for the quarter. */
  epsActualReported: number | null;
  /** FMP's estimate from the SAME surprise row as `epsActualReported`. Beat/miss
   * pairs these two (identical basis) — never `epsActualReported` against the
   * patchwork `epsEstimate`, whose old rows can be on a pre-split basis. */
  epsEstimateReported: number | null;

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

export interface SplitEvent {
  executionDate: string;
  splitFrom: number;
  splitTo: number;
}

/**
 * Cumulative EPS split factor applied AFTER `reportDate` — the product of
 * splitTo/splitFrom for every split executed later than the report. Post-split
 * EPS = pre-split EPS / factor (a 2-for-1 split → factor 2).
 */
export function splitFactorAfter(
  reportDate: string | null,
  splits: SplitEvent[],
): number {
  if (!reportDate) return 1;
  let f = 1;
  for (const s of splits) {
    if (!s.executionDate || !(s.splitFrom > 0) || !(s.splitTo > 0)) continue;
    if (s.executionDate > reportDate) f *= s.splitTo / s.splitFrom;
  }
  return f;
}

/**
 * FMP retroactively split-adjusts a historical *actual* EPS but often leaves the
 * SAME row's *estimate* on the pre-split basis — turning a small beat into a
 * fake ~50% miss (PANW's pre-Dec-2024 quarters are the textbook case). When a
 * split sits between the report and today AND the estimate is ~factor× the
 * actual (a clear split-factor gap, not a real surprise), rebase the estimate
 * onto the actual's basis. The ratio guard leaves genuine beats/misses — and
 * quarters FMP already adjusted — untouched.
 */
export function alignReportedEstimate(
  reportDate: string | null,
  splits: SplitEvent[],
  actual: number | null,
  estimate: number | null,
): number | null {
  if (actual == null || estimate == null || actual === 0) return estimate;
  const f = splitFactorAfter(reportDate, splits);
  if (f === 1) return estimate;
  const r = Math.abs(estimate / actual);
  const near = (a: number, b: number) => Math.abs(a - b) / b < 0.25;
  if (near(r, f)) return estimate / f; // estimate un-adjusted → rebase down
  if (near(r, 1 / f)) return estimate * f; // estimate over-adjusted → rebase up
  return estimate;
}

export interface EpsHistoryRow {
  fiscalYear: number;
  fiscalPeriod: string; // "Q1".."Q4"
  date: string; // FMP report date
  epsActual: number | null; // FMP consensus (non-GAAP) actual
  epsEstimate: number | null; // matched estimate, split-normalized
}

/**
 * A deep quarterly reported-EPS series from FMP's earnings surprises (~40
 * quarters / ~10 years), fiscal-year-labelled and split-normalized. Polygon's
 * financials are gappy (drops quarters) and shallow (~10), so summing THIS by
 * fiscal year is what makes annual EPS match IBD/NASDAQ all the way down.
 *
 * Fiscal labels: anchored to a Polygon quarter's exact fiscalYear/period where
 * the two overlap (recent quarters), then carried outward by list position
 * (FMP surprises are one contiguous row per quarter). Falls back to a
 * fiscal-year-end-month derivation only when no Polygon quarter overlaps.
 */
export function buildEpsHistory(
  raw: Array<{ date: string; epsActual: number | null; epsEstimate: number | null }>,
  quarters: QuarterFinancials[],
  splits: SplitEvent[],
): EpsHistoryRow[] {
  const rows = [...raw]
    .filter((r) => r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length === 0) return [];
  const qnum = (p?: string | null) => {
    const m = String(p ?? "").match(/[1-4]/);
    return m ? Number(m[0]) : null;
  };
  const labeled = quarters.filter(
    (q) => q.fiscalYear != null && qnum(q.fiscalPeriod) != null && (q.filingDate || q.endDate),
  );
  let anchor: { idx: number; abs: number } | null = null;
  rows.forEach((s, idx) => {
    for (const q of labeled) {
      const qd = (q.filingDate ?? q.endDate) as string;
      const days = Math.abs((Date.parse(s.date) - Date.parse(qd)) / 86_400_000);
      if (days <= 40) anchor = { idx, abs: Number(q.fiscalYear) * 4 + (qnum(q.fiscalPeriod)! - 1) };
    }
  });
  const q4 = labeled.find((q) => qnum(q.fiscalPeriod) === 4);
  const fyEndMonth = q4?.endDate
    ? new Date(q4.endDate + "T00:00:00").getUTCMonth() + 1
    : 12;
  return rows.map((s, idx) => {
    let abs: number;
    if (anchor) {
      abs = anchor.abs + (idx - anchor.idx);
    } else {
      const pe = new Date(Date.parse(s.date) - 40 * 86_400_000);
      const m = pe.getUTCMonth() + 1;
      const y = pe.getUTCFullYear();
      const fy = m > fyEndMonth ? y + 1 : y;
      const fyStart = (fyEndMonth % 12) + 1;
      const qi = Math.min(3, Math.max(0, Math.floor((((m - fyStart + 12) % 12)) / 3)));
      abs = fy * 4 + qi;
    }
    return {
      fiscalYear: Math.floor(abs / 4),
      fiscalPeriod: `Q${(abs % 4) + 1}`,
      date: s.date,
      epsActual: s.epsActual,
      epsEstimate: alignReportedEstimate(s.date, splits, s.epsActual, s.epsEstimate),
    };
  });
}

/** Non-GAAP TTM EPS = sum of the 4 most-recent reported quarters (FMP basis).
 * Used for a NASDAQ/IBD-style P/E (price ÷ this) instead of Polygon GAAP TTM.
 * Works off any rows carrying {date, epsActual} — raw FMP surprises or epsHistory. */
export function ttmReportedEpsFromRows(
  rows: Array<{ date: string; epsActual: number | null }>,
): number | null {
  const vals = [...rows]
    .filter((r) => r.epsActual != null && r.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (vals.length < 4) return null;
  return (
    Math.round(
      vals.slice(0, 4).reduce((s, r) => s + (r.epsActual as number), 0) * 100,
    ) / 100
  );
}

/** Non-GAAP YoY EPS growth from the two most-recent COMPLETE fiscal years in
 * epsHistory (each = sum of its 4 quarterly reported EPS). null if <2 full years. */
export function latestAnnualEpsGrowth(
  epsHistory: EpsHistoryRow[],
): number | null {
  const byFY = new Map<number, Map<string, number>>();
  for (const h of epsHistory) {
    if (h.epsActual == null) continue;
    if (!byFY.has(h.fiscalYear)) byFY.set(h.fiscalYear, new Map());
    byFY.get(h.fiscalYear)!.set(h.fiscalPeriod, h.epsActual);
  }
  const complete = [...byFY.entries()]
    .filter(([, qs]) => qs.size >= 4)
    .map(
      ([fy, qs]) =>
        [fy, [...qs.values()].reduce((s, v) => s + v, 0)] as [number, number],
    )
    .sort((a, b) => b[0] - a[0]);
  if (complete.length < 2) return null;
  const latest = complete[0][1];
  const prior = complete[1][1];
  return prior !== 0
    ? Math.round(((latest - prior) / Math.abs(prior)) * 10000) / 10000
    : null;
}

/** Maps one quarterly Polygon financials row onto the doc shape `financials/{ticker}.quarters` stores. */
export function mapQuarterRow(
  r: PolygonFinancialRow,
  epsEstimate: number | null,
  epsActualReported: number | null = null,
  epsEstimateReported: number | null = null,
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
    epsActualReported,
    epsEstimateReported,

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
          // Splits let us rebase FMP's mixed-basis historical estimates onto the
          // actual's (current) basis so beat/miss survives a stock split.
          const splits: SplitEvent[] = await this.polygon
            .getSplits(ticker)
            .catch(() => [] as SplitEvent[]);
          const prevEpsByEnd = new Map(
            (prev?.quarters ?? []).map((q) => [q.endDate, q.epsEstimate]),
          );
          const prevActualByEnd = new Map(
            (prev?.quarters ?? []).map((q) => [
              q.endDate,
              (q as { epsActualReported?: number | null }).epsActualReported ??
                null,
            ]),
          );
          const prevEstReportedByEnd = new Map(
            (prev?.quarters ?? []).map((q) => [
              q.endDate,
              (q as { epsEstimateReported?: number | null })
                .epsEstimateReported ?? null,
            ]),
          );
          const quarters: QuarterFinancials[] = rows.map((r) => {
            // The matched FMP pair (same surprise row) — beat/miss uses ONLY
            // these two so actual and estimate share a basis. The estimate is
            // split-rebased onto the actual's basis when a split sits between.
            const fmpActual = fmpQ?.epsActualFor(r.endDate) ?? null;
            const fmpEstimate = alignReportedEstimate(
              r.filingDate ?? r.endDate,
              splits,
              fmpActual,
              fmpQ?.epsEstimateFor(r.endDate) ?? null,
            );
            return mapQuarterRow(
              r,
              fmpEstimate ??
                this.matchEstimate(estimates, ticker, r.endDate) ??
                prevEpsByEnd.get(r.endDate) ??
                null,
              fmpActual ?? prevActualByEnd.get(r.endDate) ?? null,
              // Only preserve a prior reported-estimate when we ALSO fell back to
              // a prior actual, so the pair never crosses refresh boundaries.
              fmpEstimate ??
                (fmpActual == null
                  ? (prevEstReportedByEnd.get(r.endDate) ?? null)
                  : null),
            );
          });
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
          // Deep (~10yr) FMP quarterly EPS history → drives annual EPS (sum by
          // fiscal year). Preserve the prior one if FMP returns empty this run.
          const rawEpsHist = this.estimates
            ? await this.estimates.getEpsHistory(ticker).catch(() => [])
            : [];
          let epsHistory: EpsHistoryRow[] = buildEpsHistory(rawEpsHist, quarters, splits);
          if (
            epsHistory.length === 0 &&
            Array.isArray((prev as { epsHistory?: EpsHistoryRow[] })?.epsHistory)
          ) {
            epsHistory = (prev as { epsHistory?: EpsHistoryRow[] }).epsHistory!;
          }
          docs.push({
            id: ticker,
            data: {
              ticker,
              quarters,
              annual,
              annualEstimates,
              epsHistory,
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
