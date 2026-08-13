import { Controller, Get } from "@nestjs/common";
import { LiveMarketSentimentService } from "./live-market-sentiment.service";

/**
 * GET /market-data/market-sentiment(-history) — the Dashboard Fear & Greed card
 * and its history line. Both served LIVE per request from Polygon bars + today's
 * grouped-daily breadth (no cache, no job). Each returns a list to match the
 * prior collection shape (current = single-element list).
 */
@Controller("market-data")
export class MarketSentimentController {
  constructor(private readonly liveSentiment: LiveMarketSentimentService) {}

  @Get("market-sentiment")
  async marketSentiment() {
    return this.liveSentiment.getFearGreed();
  }

  @Get("market-sentiment-history")
  async marketSentimentHistory() {
    return this.liveSentiment.getHistory();
  }
}
