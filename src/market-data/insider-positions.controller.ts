import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
} from "@nestjs/common";
import { FUND_UNIVERSE } from "../common/fund-universe";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";

const ACCESSION_RE = /^[A-Za-z0-9.\-]{1,32}$/;

/**
 * GET /market-data/fund-holdings — the 5-fund 13F summary list (cached
 * top-level `fund_holdings/{cik}` docs, written by the `sec-13f` sync job).
 * GET /market-data/fund-holdings/positions — the per-filing positions
 * drill-down (`fund_holdings/{cik}/filings/{accession}/positions`), a rare
 * per-click read, so it's a direct Firestore read with no caching layer —
 * same shape as the UI's old client-side `fetchPositions`.
 */
@Controller("market-data")
export class InsiderPositionsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
    private readonly firebase: FirebaseAdminService,
  ) {}

  @Get("fund-holdings")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async fundHoldings() {
    await this.marketData.ensureFresh("sec-13f");
    const { fund_holdings } = await this.cached.get(["fund_holdings"]);
    return fund_holdings;
  }

  @Get("fund-holdings/positions")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async positions(
    @Query("cik") cik: string | undefined,
    @Query("accession") accession: string | undefined,
  ) {
    const knownCik = FUND_UNIVERSE.find((f) => f.cik === (cik ?? "").trim());
    if (!knownCik) {
      throw new BadRequestException(
        `cik must be one of: ${FUND_UNIVERSE.map((f) => f.cik).join(", ")}`,
      );
    }
    const accessionNumber = (accession ?? "").trim();
    if (!ACCESSION_RE.test(accessionNumber)) {
      throw new BadRequestException("accession is required");
    }

    const snap = await this.firebase.firestore
      .collection(
        `fund_holdings/${knownCik.cik}/filings/${accessionNumber}/positions`,
      )
      .orderBy("value", "desc")
      .limit(25)
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
}
