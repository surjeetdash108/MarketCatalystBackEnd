import { Controller, Get, Header } from "@nestjs/common";
import { Edgar8KJob } from "../sync/edgar-8k.job";

/**
 * GET /market-data/filings-wire — recent SEC-EDGAR 8-K filings as a filings
 * "newswire" feed. Backs the commentary/news filings-wire card. Live-direct:
 * swept per request from SEC-EDGAR via the source job, no Firestore cache.
 */
@Controller("market-data")
export class FilingsWireController {
  constructor(private readonly job: Edgar8KJob) {}

  @Get("filings-wire")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async filingsWire() {
    return this.job.fetchFilingsWireLive();
  }
}
