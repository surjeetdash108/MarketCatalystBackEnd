import { Injectable } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FmpService } from "../vendors/fmp/fmp.service";
import { classifyFromSic, resolveSicCode } from "../common/sic-tv.util";
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

    const secSic = await this.secEdgar.getSicByTicker(ticker);
    const resolvedSic = resolveSicCode(secSic, details.sic_code);
    const sicClass = classifyFromSic(resolvedSic);

    const data: MoverEnrichment = {
      name: details.name ?? null,
      sector: sicClass.sector,
      industry: sicClass.industry,
      cap: capBucket(details.market_cap ?? null),
      marketCap: details.market_cap ?? null,
    };
    return {
      data,
      source: this.sourceName,
      warnings: [],
    };
  }
}
