import { Controller, Get } from "@nestjs/common";
import { LiveInsiderTransactionsService } from "./live-insider-transactions.service";

/**
 * GET /market-data/insider-transactions — the Insider & Institutional screen's
 * market-wide transaction feed (the `InsiderTxDoc` shape, from SEC Form 4).
 * Served LIVE per request from EDGAR's getcurrent Form 4 stream, each filing
 * parsed for its transactions (no Firestore cache, no sync job); coalesced in
 * the service. The CUSIP/13F drill-down (`fund_holdings`) is served separately.
 */
@Controller("market-data")
export class InsiderTransactionsController {
  constructor(
    private readonly liveInsider: LiveInsiderTransactionsService,
  ) {}

  @Get("insider-transactions")
  async insiderTransactions() {
    return this.liveInsider.getInsiderTransactions();
  }
}
