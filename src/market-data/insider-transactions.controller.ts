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
 * GET /market-data/insider-transactions — the `InsiderTxDoc` feed.
 *
 *  - `?ticker=SYM` (the stock page): EVERY transaction for that ticker over the
 *    lookback window, FMP first with SEC Form 4 as backup, fetched on demand
 *    and cached per ticker — so any stock has data, not just the ones the
 *    nightly job sweeps.
 *  - no ticker (the Insider screen's market-wide feed): the `insider_transactions`
 *    collection, refreshed by the `sec-form4` job when stale per decision #3a.
 */
@Controller("market-data")
// Market data is the product. These read surfaces answered anonymous
// callers, returning full datasets — the policy lived only in a Firestore
// rules file that nothing enforces, because no client talks to Firestore.
@UseGuards(FirebaseAuthGuard)
export class InsiderTransactionsController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
    private readonly stockDetails: StockDetailsService,
  ) {}

  @Get("insider-transactions")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async insiderTransactions(
    @Query("ticker") ticker?: string,
    @Query("limit") limitParam?: string,
  ) {
    if (ticker !== undefined) {
      const sym = ticker.toUpperCase().trim();
      if (!TICKER_RE.test(sym)) {
        throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
      }
      return this.stockDetails.getInsiderTransactions(sym);
    }
    // `limit` = newest N only (the dashboard mini-list), not the full feed.
    const limit = Number(limitParam);
    const cap = <T>(rows: T[]) =>
      Number.isInteger(limit) && limit > 0 ? rows.slice(0, limit) : rows;
    // Market-wide open-market buys/sells from FMP; the SEC Form 4 collection
    // (nightly job) only when FMP has nothing.
    const latest = await this.stockDetails.getMarketWideInsiderTransactions();
    if (latest.length > 0) return cap(latest);
    await this.marketData.ensureFresh("sec-form4");
    const { insider_transactions } = await this.cached.get([
      "insider_transactions",
    ]);
    const secRows = [...(insider_transactions as Array<{ transactionDate?: string }>)].sort(
      (a, b) => String(b.transactionDate ?? "").localeCompare(String(a.transactionDate ?? "")),
    );
    return cap(secRows);
  }
}
