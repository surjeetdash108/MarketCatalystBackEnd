import { Controller, Get, Header } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";

/**
 * GET /market-data/insider-transactions — backs the Insider & Institutional
 * screen's live transaction feed (the `InsiderTxDoc` shape, sourced from SEC
 * Form 4 filings). Triggers the `sec-form4` sync job on demand when
 * stale/empty per decision #3a. The CUSIP/13F drill-down (`fund_holdings`) is
 * a separate, later phase — not served here.
 */
@Controller("market-data")
export class InsiderTransactionsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("insider-transactions")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async insiderTransactions() {
    await this.marketData.ensureFresh("sec-form4");
    const { insider_transactions } = await this.cached.get([
      "insider_transactions",
    ]);
    return insider_transactions;
  }
}
