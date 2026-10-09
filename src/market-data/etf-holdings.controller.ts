import { Controller, Get, Header, Query, NotFoundException } from "@nestjs/common";
import { EtfHoldingsService, type EtfHoldingsDoc } from "./etf-holdings.service";

@Controller("market-data")
export class EtfHoldingsController {
  constructor(private readonly etfService: EtfHoldingsService) {}

  /**
   * GET /market-data/etf-holdings?symbol=SPY
   * Returns full ETF holdings document for the requested ETF.
   */
  @Get("etf-holdings")
  @Header("Cache-Control", "public, max-age=300, s-maxage=900, stale-while-revalidate=1800")
  async getEtfHoldings(@Query("symbol") symbolParam?: string): Promise<EtfHoldingsDoc> {
    const symbol = String(symbolParam ?? "SPY").trim().toUpperCase();
    if (!symbol) {
      throw new NotFoundException("ETF symbol is required");
    }

    const doc = await this.etfService.getHoldings(symbol);
    if (!doc) {
      throw new NotFoundException(`Holdings data unavailable for ETF ${symbol}`);
    }

    return doc;
  }
}
