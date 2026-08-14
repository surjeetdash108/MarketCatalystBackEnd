import { Logger } from "@nestjs/common";
import { FmpService } from "../vendors/fmp/fmp.service";

/**
 * Earnings estimates seam — the data Polygon has no feed for. Kept behind an
 * adapter so it is fully optional/removable: when EARNINGS_ESTIMATES_SOURCE is
 * "none" (default) the token resolves to null and the earnings job writes
 * `epsEstimate: null` exactly as before.
 */

export interface EarningsEstimate {
  epsEstimate: number | null;
  revenueEstimate: number | null;
}

/** A preloaded window that answers "what did analysts expect for this report?". */
export interface EarningsEstimatesLookup {
  /** Nearest estimate for `ticker` within a few days of `date` (report date). */
  estimateFor(ticker: string, date: string | null): EarningsEstimate | null;
}

/** An upcoming (not-yet-reported) earnings date + its consensus estimates. */
export interface UpcomingEarnings {
  ticker: string;
  /** Expected report date (YYYY-MM-DD). */
  date: string;
  epsEstimate: number | null;
  /** Raw dollars. */
  revenueEstimate: number | null;
}

/** One forward fiscal year of consensus (the `*2026–28` rows). */
export interface ForwardAnnualEstimate {
  fiscalYear: string;
  epsEstimate: number | null;
  /** Raw dollars (the frontend divides by 1e6 like reported revenue). */
  revenueEstimate: number | null;
}

/** Per-ticker EPS-estimate history, matched to a quarter's period-end date. */
export interface QuarterlyEstimatesLookup {
  epsEstimateFor(periodEnd: string | null): number | null;
}

export interface EarningsEstimatesAdapter {
  readonly sourceName: string;
  /** One-shot load of every company's estimates across [from, to] (YYYY-MM-DD). */
  loadWindow(from: string, to: string): Promise<EarningsEstimatesLookup>;
  /** Upcoming reports (with estimates, no actual yet) across [from, to] — the
   * forward calendar Polygon cannot produce. Fills the hub's "today"/coming rows. */
  getUpcoming(from: string, to: string): Promise<UpcomingEarnings[]>;
  /** Forward annual estimates (current fiscal year onward) for one ticker. */
  getForwardAnnual(ticker: string): Promise<ForwardAnnualEstimate[]>;
  /** Full quarterly EPS-estimate history for one ticker (drives %surp). */
  getQuarterlyEstimates(ticker: string): Promise<QuarterlyEstimatesLookup>;
}

/** Quarter period-end may sit a little off the surprise date; match within this. */
const QUARTER_MATCH_DAYS = 90;

const EMPTY_QUARTERLY: QuarterlyEstimatesLookup = {
  epsEstimateFor: () => null,
};

/** How far a reported filing date may sit from FMP's earnings date and still match. */
const MATCH_TOLERANCE_DAYS = 21;

const EMPTY_LOOKUP: EarningsEstimatesLookup = { estimateFor: () => null };

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

/**
 * FMP-backed estimates via the bulk /earning_calendar endpoint (one request for
 * the whole window). Estimates are keyed by ticker; `estimateFor` returns the
 * entry whose earnings date is closest to the reported filing date, within a
 * tolerance — SEC filing dates and FMP announcement dates rarely align exactly.
 */
export class FmpEarningsEstimatesAdapter implements EarningsEstimatesAdapter {
  readonly sourceName = "fmp";
  private readonly logger = new Logger(FmpEarningsEstimatesAdapter.name);

  constructor(private readonly fmp: FmpService) {}

  async loadWindow(from: string, to: string): Promise<EarningsEstimatesLookup> {
    const rows = await this.fmp.getEarningsCalendar(from, to).catch((err) => {
      this.logger.warn(
        `FMP earnings calendar failed (${from}..${to}): ${err.message}`,
      );
      return [];
    });
    if (rows.length === 0) return EMPTY_LOOKUP;

    const byTicker = new Map<
      string,
      Array<{ date: string; est: EarningsEstimate }>
    >();
    for (const r of rows) {
      if (!r.symbol || !r.date) continue;
      if (r.epsEstimated == null && r.revenueEstimated == null) continue;
      const sym = r.symbol.toUpperCase();
      const list = byTicker.get(sym) ?? [];
      list.push({
        date: r.date,
        est: {
          epsEstimate: r.epsEstimated ?? null,
          revenueEstimate: r.revenueEstimated ?? null,
        },
      });
      byTicker.set(sym, list);
    }

    return {
      estimateFor: (ticker, date) => {
        if (!date) return null;
        const list = byTicker.get(ticker.toUpperCase());
        if (!list) return null;
        let best: { d: number; est: EarningsEstimate } | null = null;
        for (const e of list) {
          const d = daysBetween(e.date, date);
          if (d <= MATCH_TOLERANCE_DAYS && (!best || d < best.d))
            best = { d, est: e.est };
        }
        return best?.est ?? null;
      },
    };
  }

  async getUpcoming(from: string, to: string): Promise<UpcomingEarnings[]> {
    const rows = await this.fmp.getEarningsCalendar(from, to).catch((err) => {
      this.logger.warn(
        `FMP upcoming calendar failed (${from}..${to}): ${err.message}`,
      );
      return [];
    });
    return rows
      .filter((r) => r.symbol && r.date)
      .filter((r) => r.epsEstimated != null || r.revenueEstimated != null)
      .map((r) => ({
        ticker: r.symbol.toUpperCase(),
        date: r.date,
        epsEstimate: r.epsEstimated ?? null,
        revenueEstimate: r.revenueEstimated ?? null,
      }));
  }

  async getForwardAnnual(ticker: string): Promise<ForwardAnnualEstimate[]> {
    const rows = await this.fmp
      .getForwardAnnualEstimates(ticker)
      .catch((err) => {
        this.logger.warn(
          `FMP forward estimates failed for ${ticker}: ${err.message}`,
        );
        return [];
      });
    const thisYear = new Date().getUTCFullYear();
    return rows
      .filter((r) => r.date && Number(r.date.slice(0, 4)) >= thisYear)
      .map((r) => ({
        fiscalYear: r.date.slice(0, 4),
        epsEstimate: r.estimatedEpsAvg ?? null,
        revenueEstimate: r.estimatedRevenueAvg ?? null,
      }))
      .sort((a, b) => Number(a.fiscalYear) - Number(b.fiscalYear));
  }

  async getQuarterlyEstimates(
    ticker: string,
  ): Promise<QuarterlyEstimatesLookup> {
    const rows = await this.fmp.getEarningsSurprises(ticker).catch((err) => {
      this.logger.warn(
        `FMP earnings surprises failed for ${ticker}: ${err.message}`,
      );
      return [];
    });
    const points = rows
      .filter((r) => r.date && r.estimatedEarning != null)
      .map((r) => ({ date: r.date, eps: r.estimatedEarning as number }));
    if (points.length === 0) return EMPTY_QUARTERLY;
    return {
      epsEstimateFor: (periodEnd) => {
        if (!periodEnd) return null;
        let best: { d: number; eps: number } | null = null;
        for (const p of points) {
          const d = daysBetween(p.date, periodEnd);
          if (d <= QUARTER_MATCH_DAYS && (!best || d < best.d))
            best = { d, eps: p.eps };
        }
        return best?.eps ?? null;
      },
    };
  }
}
