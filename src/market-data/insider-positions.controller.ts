import {
  BadRequestException,
  Controller,
  Get,
  Query,
} from "@nestjs/common";
import { FUND_UNIVERSE } from "../common/fund-universe";
import { LiveFundHoldingsService } from "./live-fund-holdings.service";

const ACCESSION_RE = /^[A-Za-z0-9.\-]{1,32}$/;

/**
 * GET /market-data/fund-holdings — the fund 13F summary list.
 * GET /market-data/fund-holdings/positions — the per-filing positions drill-down.
 * Both served LIVE per request from SEC EDGAR (no cache, no job). The drill-down
 * still validates cik against FUND_UNIVERSE and the accession format.
 */
@Controller("market-data")
export class InsiderPositionsController {
  constructor(private readonly liveFunds: LiveFundHoldingsService) {}

  @Get("fund-holdings")
  async fundHoldings() {
    return this.liveFunds.getFundHoldings();
  }

  @Get("fund-holdings/positions")
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
    return this.liveFunds.getPositions(knownCik.cik, accessionNumber);
  }
}
