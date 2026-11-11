import { filedThirteenFQuarters } from "../vendors/fmp/fmp.service";
import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

/**
 * GET /market-data/institutional-ownership — ticker-indexed 13F ownership
 * rollup from FMP (owners count, % owned, QoQ holder/share change), backing
 * the Insider & Institutional screen's "13F institutional" tab. SEC 13F is
 * CUSIP-keyed so it cannot produce this per-ticker view; FMP publishes it
 * directly. Triggers the `institutional-ownership` sync job on demand when
 * stale/empty, then serves the cached collection.
 */
@Controller("market-data")
// Market data is the product. These read surfaces answered anonymous
// callers, returning full datasets — the policy lived only in a Firestore
// rules file that nothing enforces, because no client talks to Firestore.
@UseGuards(FirebaseAuthGuard)
export class InstitutionalOwnershipController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) { }

  @Get("institutional-ownership")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async institutionalOwnership() {
    await this.marketData.ensureFresh("institutional-ownership");
    const { institutional_ownership } = await this.cached.get([
      "institutional_ownership",
    ]);
    // Only quarters whose 13F deadline (45 days after quarter end) has passed:
    // before it FMP has just the early filers (AAPL 2026 Q3 on Oct 19: 862
    // holders, 0.56% "ownership"), so such a doc is not a real rollup. It is
    // replaced as the job reaches the ticker again.
    const filed = new Set(filedThirteenFQuarters(8).map((q) => `${q.year}Q${q.quarter}`));
    return (institutional_ownership as Array<{ year?: number; quarter?: number }>).filter(
      (d) => d.year != null && d.quarter != null && filed.has(`${d.year}Q${d.quarter}`),
    );
  }
}
