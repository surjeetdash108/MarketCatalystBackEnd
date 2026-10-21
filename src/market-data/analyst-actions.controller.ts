import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { StockDetailsService } from "../live/stock-details.service";
import { MarketDataService } from "./market-data.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

const TICKER_RE = /^[A-Z0-9.-]{1,10}$/;

/**
 * GET /market-data/analyst-actions — the `AnalystConsensusDoc` feed.
 *
 *  - `?ticker=SYM` (the stock page): that ticker's doc, fetched from FMP on
 *    demand when the nightly sweep has none or it is stale — so a stock outside
 *    the swept universe still gets its consensus and recent grades.
 *  - no ticker (the Analyst Actions screen): the whole `analyst_actions`
 *    collection, refreshed by the `analyst-actions` job when stale per #3a.
 */
@Controller("market-data")
// Market data is the product. These read surfaces answered anonymous
// callers, returning full datasets — the policy lived only in a Firestore
// rules file that nothing enforces, because no client talks to Firestore.
@UseGuards(FirebaseAuthGuard)
export class AnalystActionsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
    private readonly stockDetails: StockDetailsService,
  ) {}

  @Get("analyst-actions")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async analystActions(@Query("ticker") ticker?: string) {
    if (ticker !== undefined) {
      const sym = ticker.toUpperCase().trim();
      if (!TICKER_RE.test(sym)) {
        throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
      }
      const doc = await this.stockDetails.getAnalystConsensus(sym);
      // Same list shape as the unscoped feed, so one client type serves both.
      return doc ? [{ id: sym, ...doc }] : [];
    }
    // 4h TTL ensures fresh consensus across 8 AM, 12 PM, and 4 PM CST windows
    await this.marketData.ensureFresh("analyst-actions", 4 * 3600_000);
    const { analyst_actions } = await this.cached.get(["analyst_actions"]);
    return this.stockDetails.getMarketWideAnalystActions(
      analyst_actions as Record<string, unknown>[],
    );
  }

  /**
   * GET /market-data/analyst-firm-stats — measured track record per analyst
   * firm (analyst-firm-stats job: FMP grades + price targets scored against
   * FMP prices). A figure is null when the firm has fewer than 10 samples.
   */
  @Get("analyst-firm-stats")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600",
  )
  async analystFirmStats() {
    const { analyst_firm_stats } = await this.cached.get(["analyst_firm_stats"]);
    return analyst_firm_stats;
  }

  /** GET /market-data/analyst-history?ticker=SYM — every rating change on
   *  record for one stock (FMP grades), newest first. */
  @Get("analyst-history")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600",
  )
  async analystHistory(@Query("ticker") ticker?: string) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym)) {
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    }
    return this.stockDetails.getAnalystHistory(sym);
  }

  /** GET /market-data/analyst-firm-calls?firm=Name — every stored call by one
   *  firm across all measured stocks, newest first. */
  @Get("analyst-firm-calls")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=1800, stale-while-revalidate=1800",
  )
  async analystFirmCalls(@Query("firm") firm?: string) {
    const name = (firm ?? "").trim();
    if (!name || name.length > 120) {
      throw new BadRequestException("firm is required (max 120 chars)");
    }
    return this.stockDetails.getFirmCalls(name);
  }
}
