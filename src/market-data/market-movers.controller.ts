import { Controller, Get, Header } from "@nestjs/common";
import { FmpMover, FmpService } from "../vendors/fmp/fmp.service";

/**
 * GET /market-data/movers — backs the Movers screen and the Dashboard/shell
 * "Movers" widgets. Fetches live, directly from FMP per request (biggest
 * gainers + biggest losers), shaped into the `LiveMoverDoc` the UI expects
 * (see MarketCatalystUI/app/iq/types/movers.ts). No Firestore cache, no sync
 * job — the response is computed fresh on every call.
 */
@Controller("market-data")
export class MarketMoversController {
  constructor(private readonly fmp: FmpService) {}

  @Get("movers")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async movers() {
    const asOfDate = new Date().toISOString().slice(0, 10);

    const toDoc = (m: FmpMover, direction: "gainer" | "loser") => ({
      id: `${direction}_${m.symbol}`,
      ticker: m.symbol,
      name: m.name ?? null,
      price: m.price,
      pctChange: m.changesPercentage,
      // FMP's gainers/losers feeds carry no volume; the UI shows it as "—".
      volume: 0,
      // sector/cap need a per-ticker profile lookup (40 calls) — too slow to
      // block a live request on, so left null. The UI defaults these to
      // "—"/"Mid" respectively.
      sector: null as string | null,
      cap: null as string | null,
      direction,
      asOfDate,
    });

    const [gainers, losers] = await Promise.all([
      this.fmp.getGainers(),
      this.fmp.getLosers(),
    ]);

    return [
      ...gainers.map((g) => toDoc(g, "gainer")),
      ...losers.map((l) => toDoc(l, "loser")),
    ];
  }
}
