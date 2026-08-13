import { Controller, Get } from "@nestjs/common";
import { Edgar8kFeedService } from "./edgar-8k-feed.service";

/**
 * GET /market-data/filings-wire — recent SEC-EDGAR 8-K filings as a market-wide
 * "newswire" feed, backing the commentary/news filings-wire card. Served LIVE
 * per request from EDGAR's getcurrent 8-K stream (no Firestore cache, no sync
 * job); coalesced in the shared Edgar8kFeedService.
 */
@Controller("market-data")
export class FilingsWireController {
  constructor(private readonly feed: Edgar8kFeedService) {}

  @Get("filings-wire")
  async filingsWire() {
    const { wireDocs } = await this.feed.fetchAll();
    return wireDocs;
  }
}
