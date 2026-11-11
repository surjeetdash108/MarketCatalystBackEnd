import { Controller, Get, Header, Param, Query, UseGuards } from "@nestjs/common";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { MoverCatalystService } from "../live/mover-catalyst.service";

@Controller("market-data")
@UseGuards(FirebaseAuthGuard)
export class MoverCatalystsController {
  constructor(private readonly catalystService: MoverCatalystService) {}

  /**
   * GET /market-data/mover-catalysts?tickers=AAPL,NVDA,TSLA
   * Query catalyst reasons for multiple mover tickers in batch.
   */
  @Get("mover-catalysts")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async getBatchCatalysts(@Query("tickers") tickersStr?: string) {
    if (!tickersStr) {
      return {};
    }
    const tickers = tickersStr.split(",").map((t) => t.trim()).filter(Boolean);
    return this.catalystService.getBatchCatalysts(tickers);
  }

  /**
   * GET /market-data/mover-catalyst/:ticker
   * Query catalyst reason for a single stock ticker.
   */
  @Get("mover-catalyst/:ticker")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async getSingleCatalyst(
    @Param("ticker") ticker: string,
    @Query("direction") direction?: string,
    @Query("pctChange") pctChange?: string,
  ) {
    const numChange = pctChange ? Number(pctChange) : undefined;
    return this.catalystService.getOrResolveCatalyst(
      ticker,
      direction,
      Number.isFinite(numChange) ? numChange : undefined,
    );
  }
}
