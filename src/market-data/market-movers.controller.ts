import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

/**
 * GET /market-data/movers — backs the Movers screen and the Dashboard/shell
 * "Movers" widgets. Shapes straight off `market_movers` (already the
 * `LiveMoverDoc` shape the UI expects — see cached-collections.service.ts's
 * `{ id: d.id, ...d.data() }` mapping), triggering the `market-movers` sync
 * job on demand when stale/empty per decision #3a — no cron populates this.
 */
@Controller("market-data")
// Market data is the product. These read surfaces answered anonymous
// callers, returning full datasets — the policy lived only in a Firestore
// rules file that nothing enforces, because no client talks to Firestore.
@UseGuards(FirebaseAuthGuard)
export class MarketMoversController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
    private readonly firebase: FirebaseAdminService,
  ) {}

  @Get("movers")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async movers() {
    await this.marketData.ensureFresh("market-movers");
    const { market_movers } = await this.cached.get(["market_movers"]);
    return market_movers;
  }

  /**
   * GET /market-data/volume-leaders — the whole US market ranked by relative
   * volume, already sorted.
   *
   * ONE pre-ranked document, not a collection. The board used to pull every
   * company and sort in the browser, which is 2.6 MB for 923 names and would be
   * ~38 MB across the ~12,600 listed symbols this now covers. Ranking belongs
   * on the server precisely so the payload stops tracking the universe size.
   *
   * Served empty (not 404) until volume-leaders has run: an empty list renders
   * as "no data yet", where an error renders as broken.
   */
  @Get("volume-leaders")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async volumeLeaders() {
    const snap = await this.firebase.firestore
      .collection("volume_leaders")
      .doc("current")
      .get();
    const d = snap.data();
    return {
      date: d?.date ?? null,
      leaders: Array.isArray(d?.leaders) ? d.leaders : [],
      universeSize: d?.universeSize ?? 0,
      updatedAt: d?.updatedAt ?? null,
    };
  }
}
