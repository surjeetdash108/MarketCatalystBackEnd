import { Controller, Get, Header } from '@nestjs/common';
import { Edgar8kFeedService } from './edgar-8k-feed.service';

/**
 * GET /market-data/filings-wire — the 8-K filings "newswire" feed. Calls SEC
 * EDGAR directly on every request (no Firestore cache, no sync job) via
 * Edgar8kFeedService — mirrors edgar-8k.job.ts's fetch, minus persistence.
 * See Edgar8kFeedService for the SEC rate-limit tradeoff this implies.
 */
@Controller('market-data')
export class FilingsWireController {
  constructor(private readonly edgar8k: Edgar8kFeedService) {}

  @Get('filings-wire')
  @Header('Cache-Control', 'no-store')
  async filingsWire() {
    const { wireDocs } = await this.edgar8k.fetchAll();
    return wireDocs;
  }
}
