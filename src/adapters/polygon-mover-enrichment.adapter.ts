import { Injectable } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { sectorFromSic } from "../common/sic-sector.util";
import {
  AdapterResult,
  capBucket,
  MoverEnrichment,
  MoverEnrichmentAdapter,
} from "./types";

@Injectable()
export class PolygonMoverEnrichmentAdapter implements MoverEnrichmentAdapter {
  readonly sourceName = "polygon";

  constructor(private readonly polygon: PolygonService) {}

  async enrichTicker(
    ticker: string,
  ): Promise<AdapterResult<MoverEnrichment> | null> {
    const details = await this.polygon.getTickerDetails(ticker);
    if (!details) return null;
    // Derive the canonical sector from the SIC CODE (not the free-text
    // sic_description, which never matched the app's 11 SPDR sector names and
    // broke the movers sector filter). Null when the code is unmapped.
    const data: MoverEnrichment = {
      name: details.name ?? null,
      sector: sectorFromSic(details.sic_code ?? null),
      cap: capBucket(details.market_cap ?? null),
    };
    return {
      data,
      source: this.sourceName,
      warnings: [],
    };
  }
}
