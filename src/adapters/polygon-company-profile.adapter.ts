import { Injectable, Logger } from "@nestjs/common";
import { resolveSector } from "../common/sic-sector.util";
import { reconcileMarketCap } from "../common/validate.util";
import {
  forwardAnnualDividend,
  type DivHistItem,
} from "../common/dividend-annualization.util";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FmpService } from "../vendors/fmp/fmp.service";
import {
  AdapterResult,
  AdapterWarning,
  CanonicalCompany,
  CompanyProfileAdapter,
} from "./types";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class PolygonCompanyProfileAdapter implements CompanyProfileAdapter {
  readonly sourceName = "polygon";
  private readonly logger = new Logger(PolygonCompanyProfileAdapter.name);

  constructor(
    private readonly polygon: PolygonService,
    // FMP is used ONLY to refine the sector classification (its GICS `sector` is
    // cleaner than Polygon's free-text SIC). Best-effort and self-disabling when
    // no key is set — the sector then falls back to the SIC mapping.
    private readonly fmp: FmpService,
  ) {}

  async fetchCompany(
    ticker: string,
  ): Promise<AdapterResult<CanonicalCompany> | null> {
    const details = await this.polygon.getTickerDetails(ticker);
    if (!details) return null;
    // Kicked off in parallel with the price/eps/peers/dividend fetches below so
    // it adds max(), not sum(), to latency. Null on any failure → SIC fallback.
    const fmpProfilePromise = this.fmp.enabled
      ? this.fmp.getCompanyProfile(ticker).catch(() => null)
      : Promise.resolve(null);
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
    // Prefer the universal snapshot — the SAME source the on-demand path uses —
    // so a swept doc and a viewed doc derive price/pctChange identically, instead
    // of the sweep writing a stale daily-bar close over the live snapshot value.
    const snap = (
      (await this.polygon.getUniversalSnapshot([ticker]).catch(() => [])) as Array<{
        price?: number | null;
        changePercent?: number | null;
      }>
    )[0];
    if (snap?.price != null) {
      price = snap.price;
      pctChange = snap.changePercent ?? null;
    }
    // Daily-bar close as a coverage fallback for thin names the snapshot misses.
    if (price == null) try {
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

    const fmpProfile = await fmpProfilePromise;

    const data: CanonicalCompany = {
      ticker,
      name: details.name ?? null,
      price,
      pctChange,
      // Prefer the current price × shares when Polygon's reference market_cap is
      // grossly stale (see reconcileMarketCap); otherwise keep Polygon's value.
      marketCap: reconcileMarketCap(
        details.market_cap,
        price,
        details.weighted_shares_outstanding,
      ),
      beta: null,
      // sic_description is an INDUSTRY ("ELECTRONIC COMPUTERS"), not a sector.
      // Writing it to both fields put SIC descriptions in companies.sector,
      // which tech-rating groups by to compute sectorRank — so ranks were
      // computed within an SIC code rather than a sector, and the field could
      // never be joined against the `sectors` collection. Derive the sector
      // from sic_code instead; null when unmappable, never a guess.
      sector: resolveSector(details.sic_code, {
        ticker: details.ticker,
        name: details.name,
        description: details.description,
        fmpSector: fmpProfile?.sector ?? null,
      }),
      // Prefer FMP's clean GICS industry when wired; SIC description is fallback.
      industry: fmpProfile?.industry ?? details.sic_description ?? null,
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
