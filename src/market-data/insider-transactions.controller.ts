import { Controller, Get, Header } from "@nestjs/common";
import { SecForm4Job } from "../sync/sec-form4.job";

/**
 * GET /market-data/insider-transactions — backs the Insider & Institutional
 * screen's live transaction feed (the `InsiderTxDoc` shape, sourced from SEC
 * Form 4 filings). Live-direct: swept per request from SEC-EDGAR via the source
 * job, no Firestore cache.
 */
@Controller("market-data")
export class InsiderTransactionsController {
  constructor(private readonly job: SecForm4Job) {}

  @Get("insider-transactions")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async insiderTransactions() {
    return this.job.fetchLive();
  }
}
