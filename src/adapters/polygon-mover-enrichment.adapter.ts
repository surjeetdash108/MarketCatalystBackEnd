import { Injectable } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FmpService } from "../vendors/fmp/fmp.service";
import { resolveSector } from "../common/sic-sector.util";
import { classifyFromSic } from "../common/sic-tv.util";
import {
  AdapterResult,
  capBucket,
  MoverEnrichment,
  MoverEnrichmentAdapter,
} from "./types";

@Injectable()
export class PolygonMoverEnrichmentAdapter implements MoverEnrichmentAdapter {
  readonly sourceName = "polygon";

  constructor(
    private readonly polygon: PolygonService,
    // Used ONLY to refine the sector (FMP's GICS label beats Polygon's coarse
    // SIC bucket). Best-effort, self-disabling with no key → SIC fallback.
    private readonly fmp: FmpService,
  ) {}

  async enrichTicker(
    ticker: string,
  ): Promise<AdapterResult<MoverEnrichment> | null> {
    const [details, fmpProfile] = await Promise.all([
      this.polygon.getTickerDetails(ticker),
      this.fmp.enabled
        ? this.fmp.getCompanyProfile(ticker).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!details) return null;
    // Sector: prefer FMP's GICS classification, else derive from the SIC CODE
    // (not the free-text sic_description, which never matched the app's 11 SPDR
    // sector names and broke the movers sector filter). Null when unmapped.
    const data: MoverEnrichment = {
      name: details.name ?? null,
      // TradingView (RBICS) taxonomy, derived from the SIC code — the single
      // classification path, so a ticker first seen here matches the one the
      // profile job writes later.
      sector: classifyFromSic(details.sic_code ?? null).sector,
      cap: capBucket(details.market_cap ?? null),
    };
    return {
      data,
      source: this.sourceName,
      warnings: [],
    };
  }
}
