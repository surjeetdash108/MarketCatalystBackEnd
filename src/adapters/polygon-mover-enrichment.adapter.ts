import { Injectable } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FmpService } from "../vendors/fmp/fmp.service";
import { classifyFromSic } from "../common/sic-tv.util";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";
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
    private readonly fmp: FmpService,
    private readonly secEdgar: SecEdgarService,
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
    const polySic = details.sic_code;
    const hasPolySic =
      polySic != null &&
      String(polySic).trim() !== "" &&
      String(polySic).trim() !== "0";

    const secSic = await this.secEdgar.getSicByTicker(ticker);

    const resolvedSic =
      secSic != null
        ? secSic
        : hasPolySic
          ? polySic
          : null;

    const sicClass = classifyFromSic(resolvedSic);
    // Sector: prefer FMP's GICS classification, else derive from the SIC CODE
    // (not the free-text sic_description, which never matched the app's 11 SPDR
    // sector names and broke the movers sector filter). Null when unmapped.
    const data: MoverEnrichment = {
      name: details.name ?? null,
      // TradingView (RBICS) taxonomy, derived from the SIC code — the single
      // classification path, so a ticker first seen here matches the one the
      // profile job writes later.
      sector: sicClass.sector,
      cap: capBucket(details.market_cap ?? null),
      // Same value the tier is bucketed from — kept raw for the table column.
      marketCap: details.market_cap ?? null,
    };
    return {
      data,
      source: this.sourceName,
      warnings: [],
    };
  }
}
