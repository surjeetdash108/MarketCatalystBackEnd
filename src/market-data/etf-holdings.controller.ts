import { UseGuards, Controller, Get, Header, Query, NotFoundException } from "@nestjs/common";
import { EtfHoldingsService, type EtfHoldingsDoc } from "./etf-holdings.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { RequiresEntitlement } from "../entitlements/requires-entitlement.decorator";

@Controller("market-data")
@UseGuards(FirebaseAuthGuard)
export class EtfHoldingsController {
  constructor(private readonly etfService: EtfHoldingsService) {}

  /**
   * GET /market-data/etf-holdings?symbol=SPY
   * Returns full ETF holdings document for the requested ETF.
   */
  @RequiresEntitlement("workspaces")
  @Get("etf-holdings")
  // private: the response is per-authenticated-request; a shared CDN copy
  // would hand it to callers who never presented a token.
  @Header("Cache-Control", "private, max-age=300")
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
