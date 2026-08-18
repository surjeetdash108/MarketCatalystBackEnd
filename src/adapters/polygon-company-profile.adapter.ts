import { Injectable, Logger } from "@nestjs/common";
import { sectorFromSic } from "../common/sic-sector.util";
import { PolygonService } from "../vendors/polygon/polygon.service";
import {
  AdapterResult,
  AdapterWarning,
  CanonicalCompany,
  CompanyProfileAdapter,
} from "./types";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Distribution-type codes Polygon uses for NON-regular payments (special cash,
 * long-term / short-term capital-gains). Excluded from the forward run-rate so a
 * one-off does not masquerade as the recurring dividend. Mirrors
 * live/ondemand.service.ts.
 */
const SPECIAL_DIVIDEND_TYPES = new Set(["SC", "LT", "ST"]);

/** Subset of a Polygon getDividendHistory() row the forward yield needs. */
interface DivHistItem {
  exDividendDate: string | null;
  cashAmount: number | null;
  dividendType: string | null;
  frequency: number | null;
}

/**
 * Polygon's `frequency` integer is a payments-per-year count when it is a real
 * cadence (1 = annual, 2 = semi-annual, 4 = quarterly, 12 = monthly). 0 = one-
 * time and null are not usable cadences → return null so the caller falls back
 * to ex-date spacing.
 */
function paymentsPerYearFromFrequency(freq: number | null): number | null {
  return freq === 1 || freq === 2 || freq === 4 || freq === 12 ? freq : null;
}

/**
 * Infer payments-per-year from the median spacing of recent (newest-first)
 * regular ex-dates: pick the cadence in {12,4,2,1} whose expected gap 365/n is
 * closest to the observed median gap (~30d→12, ~91d→4, ~182d→2, ~365d→1).
 * Needs at least two ex-dates to form a gap; returns null otherwise.
 */
function paymentsPerYearFromSpacing(regular: DivHistItem[]): number | null {
  const dates = regular
    .map((d) => (d.exDividendDate ? Date.parse(d.exDividendDate) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a);
  if (dates.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 0; i < dates.length - 1; i++) {
    gaps.push((dates[i] - dates[i + 1]) / 86_400_000);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median =
    gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
  if (!(median > 0)) return null;
  let best: number | null = null;
  let bestErr = Infinity;
  for (const n of [12, 4, 2, 1]) {
    const err = Math.abs(median - 365 / n);
    if (err < bestErr) {
      bestErr = err;
      best = n;
    }
  }
  return best;
}

/**
 * FORWARD-ANNUALIZED dividend per share from a ticker's dividend history
 * (newest-first, as Polygon returns it):
 *   perShare = (most-recent REGULAR per-payment amount) × (payments per year).
 * Special / one-time distributions are excluded from both the per-payment amount
 * and the spacing; cashAmount is read null-safe. Returns null when neither the
 * frequency nor the ex-date spacing determines a cadence, so the caller leaves
 * dividendYield null rather than falling back to a (misleading) TTM sum. Mirrors
 * live/ondemand.service.ts.
 */
function forwardAnnualDividend(
  history: DivHistItem[],
): { perShare: number; paymentsPerYear: number } | null {
  const regular = history.filter(
    (d) =>
      (d.cashAmount ?? 0) > 0 &&
      d.frequency !== 0 &&
      !(d.dividendType != null && SPECIAL_DIVIDEND_TYPES.has(d.dividendType)),
  );
  if (regular.length === 0) return null;

  // history is newest-first, so the first regular row is the latest payment.
  const perPayment = regular[0].cashAmount ?? 0;
  if (!(perPayment > 0)) return null;

  const paymentsPerYear =
    paymentsPerYearFromFrequency(regular[0].frequency) ??
    paymentsPerYearFromSpacing(regular);
  if (paymentsPerYear == null) return null;

  return { perShare: perPayment * paymentsPerYear, paymentsPerYear };
}

@Injectable()
export class PolygonCompanyProfileAdapter implements CompanyProfileAdapter {
  readonly sourceName = "polygon";
  private readonly logger = new Logger(PolygonCompanyProfileAdapter.name);

  constructor(private readonly polygon: PolygonService) {}

  async fetchCompany(
    ticker: string,
  ): Promise<AdapterResult<CanonicalCompany> | null> {
    const details = await this.polygon.getTickerDetails(ticker);
    if (!details) return null;
    // These three used to be declared FIELD_NOT_SUPPORTED here, on the belief
    // that Polygon sells neither a peer list nor a dividend yield. Both were
    // wrong in different ways, verified against the live plan on 2026-07-21:
    //   peers  — /v1/related-companies is authorized and returns real tickers.
    //   yield  — there is indeed no yield PRODUCT, but the dividend history that
    //            derives it is right there; a FORWARD-ANNUALIZED run-rate over
    //            price is the number a vendor would sell back (see the helpers
    //            below and the matching logic in live/ondemand.service.ts).
    const warnings: AdapterWarning[] = [];
    let price = null;
    let pctChange = null;
    try {
      const to = new Date();
      const from = new Date(to);
      from.setUTCDate(from.getUTCDate() - 7);
      const bars = await this.polygon.getAggsRange(
        ticker,
        isoDate(from),
        isoDate(to),
      );
      if (bars.length >= 2) {
        const last = bars[bars.length - 1];
        const prev = bars[bars.length - 2];
        price = last.c;
        pctChange =
          prev.c > 0
            ? Math.round(((last.c - prev.c) / prev.c) * 10000) / 100
            : null;
      } else if (bars.length === 1) {
        price = bars[0].c;
        warnings.push({
          code: "SUB_REQUEST_FAILED",
          field: "pctChange",
          message:
            "Only one trading day of bars returned in the lookback window — cannot compute pctChange.",
        });
      } else {
        warnings.push({
          code: "SUB_REQUEST_FAILED",
          field: "price,pctChange",
          message:
            "No recent bars returned for this ticker in the last 7 days.",
        });
      }
    } catch (err) {
      const reason = err.message;
      this.logger.warn(`Failed fetching recent bars for ${ticker}: ${reason}`);
      warnings.push({
        code: "SUB_REQUEST_FAILED",
        field: "price,pctChange",
        message: `Recent-bars request failed: ${reason}`,
      });
    }
    let eps = null;
    let peRatio = null;
    try {
      eps = await this.polygon.getTtmEps(ticker);
      if (eps != null && price != null && eps > 0) {
        peRatio = Math.round((price / eps) * 100) / 100;
      }
    } catch (err) {
      const reason = err.message;
      this.logger.warn(`Failed fetching TTM EPS for ${ticker}: ${reason}`);
      warnings.push({
        code: "SUB_REQUEST_FAILED",
        field: "eps,peRatio",
        message: `TTM financials request failed: ${reason}`,
      });
    }
    let peers: string[] = [];
    try {
      // Self is excluded — the endpoint does not return it today, but a peer
      // list that contains the company itself renders as a nonsense row.
      peers = (await this.polygon.getRelatedCompanies(ticker)).filter(
        (p) => p !== ticker,
      );
    } catch (err) {
      const reason = err.message;
      this.logger.warn(`Failed fetching peers for ${ticker}: ${reason}`);
      warnings.push({
        code: "SUB_REQUEST_FAILED",
        field: "peers",
        message: `Related-companies request failed: ${reason}`,
      });
    }

    let dividendPerShare: number | null = null;
    let dividendYield: number | null = null;
    try {
      const history = await this.polygon.getDividendHistory(ticker, 40);
      // FORWARD-ANNUALIZED yield (matches live/ondemand.service.ts). Both
      // dividendPerShare and dividendYield are built from the forward run-rate:
      //   forwardAnnualDividend = (most-recent REGULAR per-payment amount)
      //                           × (payments-per-year for the payer's cadence)
      //   dividendYield         = forwardAnnualDividend / price   (price > 0)
      // A trailing-12-month SUM overstates the yield whenever a rolling 365-day
      // window happens to hold a 5th quarterly ex-date (PEP: ~5.25% TTM vs the
      // true ~4.27% forward). Cadence comes from Polygon's `frequency` integer,
      // else from the median ex-date spacing; special/one-time distributions are
      // excluded. When the cadence is indeterminate BOTH stay null — never a TTM
      // fallback. dividendPerShare keeps the forward-annual meaning throughout.
      const fwd = forwardAnnualDividend(history);
      if (fwd) {
        dividendPerShare = Math.round(fwd.perShare * 10000) / 10000;
        if (price != null && price > 0) {
          dividendYield = Math.round((fwd.perShare / price) * 10000) / 100;
        }
      }
    } catch (err) {
      const reason = err.message;
      this.logger.warn(
        `Failed fetching dividend history for ${ticker}: ${reason}`,
      );
      warnings.push({
        code: "SUB_REQUEST_FAILED",
        field: "dividendYield,dividendPerShare",
        message: `Dividend-history request failed: ${reason}`,
      });
    }

    const data: CanonicalCompany = {
      ticker,
      name: details.name ?? null,
      price,
      pctChange,
      marketCap: details.market_cap ?? null,
      beta: null,
      // sic_description is an INDUSTRY ("ELECTRONIC COMPUTERS"), not a sector.
      // Writing it to both fields put SIC descriptions in companies.sector,
      // which tech-rating groups by to compute sectorRank — so ranks were
      // computed within an SIC code rather than a sector, and the field could
      // never be joined against the `sectors` collection. Derive the sector
      // from sic_code instead; null when unmappable, never a guess.
      sector: sectorFromSic(details.sic_code),
      industry: details.sic_description ?? null,
      exchange: details.primary_exchange ?? null,
      week52Range: null,
      volume: null,
      averageVolume: null,
      description: details.description ?? null,
      peRatio,
      eps,
      dividendYield,
      dividendPerShare,
      peers,
    };
    return { data, source: this.sourceName, warnings };
  }
}
