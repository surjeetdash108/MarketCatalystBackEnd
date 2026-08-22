import { Logger } from "@nestjs/common";
import { FmpService } from "../vendors/fmp/fmp.service";
import { daysBetween } from "../common/date.util";

/**
 * Earnings estimates seam — the data Polygon has no feed for. Kept behind an
 * adapter so it is fully optional/removable: when EARNINGS_ESTIMATES_SOURCE is
 * "none" (default) the token resolves to null and the earnings job writes
 * `epsEstimate: null` exactly as before.
 */

export interface EarningsEstimate {
  epsEstimate: number | null;
  revenueEstimate: number | null;
  /** FMP's reported EPS actual for this report — the consensus (non-GAAP)
   * basis, so beat/miss vs epsEstimate is like-for-like. Null for a future
   * report or when FMP carries no actual. Prefer this over Polygon GAAP EPS. */
  epsActual: number | null;
}

/** A preloaded window that answers "what did analysts expect for this report?". */
export interface EarningsEstimatesLookup {
  /** Nearest estimate for `ticker` within a few days of `date` (report date). */
  estimateFor(ticker: string, date: string | null): EarningsEstimate | null;
}

/** An earnings date + its consensus estimates. When the date is in the recent
 *  past, `epsActual`/`revenueActual` carry the reported numbers (FMP announces
 *  before the SEC 10-Q Polygon keys on files). */
export interface UpcomingEarnings {
  ticker: string;
  /** Report date (YYYY-MM-DD). */
  date: string;
  epsEstimate: number | null;
  /** Raw dollars. */
  revenueEstimate: number | null;
  /** Reported actuals when already announced, else null (future date). */
  epsActual: number | null;
  revenueActual: number | null;
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
  /** FMP's reported EPS actual for that quarter — the consensus-basis
   * (non-GAAP) figure, so beat/miss vs `epsEstimateFor` is apples-to-apples.
   * Prefer this over Polygon's GAAP diluted EPS for surprise math. */
  epsActualFor(periodEnd: string | null): number | null;
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
  /** Raw reported EPS history — up to ~40 quarters of {reportDate, actual,
   * estimate} on FMP's consensus (non-GAAP) basis. Drives the deep annual EPS
   * series (sum of quarters per fiscal year) that Polygon's gappy financials
   * can't. Empty array when the adapter is off or has no coverage. */
  getEpsHistory(
    ticker: string,
  ): Promise<
    Array<{ date: string; epsActual: number | null; epsEstimate: number | null }>
  >;
}

/** Quarter period-end may sit a little off the surprise date; match within this. */
const QUARTER_MATCH_DAYS = 90;

const EMPTY_QUARTERLY: QuarterlyEstimatesLookup = {
  epsEstimateFor: () => null,
  epsActualFor: () => null,
};

/** How far a reported filing date may sit from FMP's earnings date and still match. */
const MATCH_TOLERANCE_DAYS = 21;

const EMPTY_LOOKUP: EarningsEstimatesLookup = { estimateFor: () => null };


/**
 * Keep each earnings-calendar slice well under FMP's ~4000-row request cap.
 *
 * MUST stay small: the calendar is GLOBAL, not US-only, and runs ~700-750 rows
 * PER DAY in season (a 24-25 Aug 2026 probe returned 1,467 for two days). At
 * the previous 45 this asked for ~33,000 rows in one request — 8x the cap — and
 * FMP silently returns only the far end, so every near-term date was thrown
 * away before our US filter ever saw it. That is why the dashboard showed no
 * earnings for the next few days while November rows were present: DKS, BNS,
 * VIPS and ~600 other US symbols reporting on 24-25 Aug never arrived.
 *
 * 5 days x ~750 = ~3,750, inside the cap with headroom. The extra requests are
 * cheap: a 180-day window is 36 calls on a daily job.
 */
const CALENDAR_CHUNK_DAYS = 5;
/** Row count at which a slice is assumed truncated by the vendor cap. */
const CALENDAR_TRUNCATION_WARN = 3500;

/** Split [from,to] (inclusive, YYYY-MM-DD) into <=`days`-long [start,end] slices. */
function chunkWindow(
  from: string,
  to: string,
  days: number,
): Array<[string, string]> {
  const DAY = 86_400_000;
  const start0 = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start0) || !Number.isFinite(end) || start0 > end) {
    return from && to ? [[from, to]] : [];
  }
  const out: Array<[string, string]> = [];
  let start = start0;
  while (start <= end) {
    const sliceEnd = Math.min(start + (days - 1) * DAY, end);
    out.push([
      new Date(start).toISOString().slice(0, 10),
      new Date(sliceEnd).toISOString().slice(0, 10),
    ]);
    start = sliceEnd + DAY;
  }
  return out;
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
          epsActual: r.epsActual ?? null,
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
    // FMP's earnings-calendar caps a SINGLE request at ~4000 rows and silently
    // drops the overflow (keeping the far end of the window), so a multi-month
    // span must be pulled in <=CHUNK_DAYS slices and merged, or the near-term
    // dates vanish. Dedup by symbol+date across the slice boundaries.
    const seen = new Set<string>();
    const out: UpcomingEarnings[] = [];
    for (const [f, t] of chunkWindow(from, to, CALENDAR_CHUNK_DAYS)) {
      const rows = await this.fmp.getEarningsCalendar(f, t).catch((err) => {
        this.logger.warn(
          `FMP upcoming calendar failed (${f}..${t}): ${err.message}`,
        );
        return [];
      });
      // The cap is enforced by silent truncation, so a slice that comes back
      // near it has probably lost rows. Shout rather than quietly under-report.
      if (rows.length >= CALENDAR_TRUNCATION_WARN) {
        this.logger.warn(
          `FMP earnings-calendar ${f}..${t} returned ${rows.length} rows — at or near the vendor cap, so earlier dates in this slice may have been dropped. Lower CALENDAR_CHUNK_DAYS.`,
        );
      }
      for (const r of rows) {
        if (!r.symbol || !r.date) continue;
        // Keep a row if it carries ANY of estimate/actual (a just-announced row
        // may have only actuals).
        if (
          r.epsEstimated == null &&
          r.revenueEstimated == null &&
          r.epsActual == null &&
          r.revenueActual == null
        )
          continue;
        const ticker = r.symbol.toUpperCase();
        const key = `${ticker}_${r.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ticker,
          date: r.date,
          epsEstimate: r.epsEstimated ?? null,
          revenueEstimate: r.revenueEstimated ?? null,
          epsActual: r.epsActual ?? null,
          revenueActual: r.revenueActual ?? null,
        });
      }
    }
    return out;
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
    // Keep the estimate AND the matched actual from the SAME FMP `/earnings`
    // row. FMP's epsActual is the consensus-basis (non-GAAP) figure, so it is
    // apples-to-apples with epsEstimated — unlike Polygon's GAAP diluted EPS,
    // which yields spurious huge beats/misses for names with heavy SBC or
    // one-off tax items (PANW being a textbook case).
    const points = rows
      .filter((r) => r.date && (r.estimatedEarning != null || r.actualEarningResult != null))
      .map((r) => ({ date: r.date, eps: r.estimatedEarning, actual: r.actualEarningResult }));
    if (points.length === 0) return EMPTY_QUARTERLY;
    const nearest = (periodEnd: string | null) => {
      if (!periodEnd) return null;
      let best: { d: number; p: (typeof points)[number] } | null = null;
      for (const p of points) {
        const d = daysBetween(p.date, periodEnd);
        if (d <= QUARTER_MATCH_DAYS && (!best || d < best.d)) best = { d, p };
      }
      return best?.p ?? null;
    };
    return {
      epsEstimateFor: (periodEnd) => nearest(periodEnd)?.eps ?? null,
      epsActualFor: (periodEnd) => nearest(periodEnd)?.actual ?? null,
    };
  }

  async getEpsHistory(
    ticker: string,
  ): Promise<
    Array<{ date: string; epsActual: number | null; epsEstimate: number | null }>
  > {
    const rows = await this.fmp.getEarningsSurprises(ticker).catch((err) => {
      this.logger.warn(
        `FMP EPS history failed for ${ticker}: ${err.message}`,
      );
      return [];
    });
    return rows
      .filter((r) => r.date)
      .map((r) => ({
        date: r.date,
        epsActual: r.actualEarningResult,
        epsEstimate: r.estimatedEarning,
      }));
  }
}
