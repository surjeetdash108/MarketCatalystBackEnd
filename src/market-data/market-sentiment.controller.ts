import { Controller, Get, Header } from "@nestjs/common";
import { FearGreedJob } from "../sync/fear-greed.job";

/**
 * GET /market-data/market-sentiment — backs the Dashboard's Fear & Greed card.
 * Live-direct: computed per request from Polygon via the source job, no
 * Firestore cache.
 */
@Controller("market-data")
export class MarketSentimentController {
  constructor(private readonly job: FearGreedJob) {}

  @Get("market-sentiment")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async marketSentiment() {
    return this.job.fetchLatestLive();
  }

  /**
   * GET /market-data/market-sentiment-history — the composite Fear & Greed
   * value per past trading day. Backs the Dashboard's F&G history line.
   * Price components come live from Polygon; the per-day breadth input is joined
   * from `market_breadth` (no single-call vendor source exists for it).
   */
  @Get("market-sentiment-history")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async marketSentimentHistory() {
    return this.job.fetchHistoryLive();
  }
}
