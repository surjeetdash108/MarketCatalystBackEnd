import { Controller, Get } from "@nestjs/common";
import { LiveEarningsService } from "./live-earnings.service";

/**
 * GET /market-data/earnings — the Earnings Hub calendar (`LiveEarningsDoc`).
 * Served LIVE per request from FMP's earnings-calendar (past + future, with
 * estimates). No cache, no job.
 */
@Controller("market-data")
export class EarningsController {
  constructor(private readonly liveEarnings: LiveEarningsService) {}

  @Get("earnings")
  async earnings() {
    return this.liveEarnings.getEarnings();
  }
}
