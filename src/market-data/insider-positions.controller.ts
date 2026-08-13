import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
} from "@nestjs/common";
import { FUND_UNIVERSE } from "../common/fund-universe";
import { Sec13FJob } from "../sync/sec-13f.job";

const ACCESSION_RE = /^[A-Za-z0-9.\-]{1,32}$/;

/**
 * GET /market-data/fund-holdings — the 5-fund 13F summary list.
 * GET /market-data/fund-holdings/positions — the per-filing positions
 * drill-down. Both live-direct: fetched per request from SEC-EDGAR via the
 * source job, no Firestore cache.
 */
@Controller("market-data")
export class InsiderPositionsController {
  constructor(private readonly job: Sec13FJob) {}

  @Get("fund-holdings")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async fundHoldings() {
    return this.job.fetchLive();
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

    return this.job.fetchPositionsLive(knownCik.cik, accessionNumber);
  }
}
