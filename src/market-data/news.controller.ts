import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { MarketDataService } from "./market-data.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

// A bounded, sorted view of `news` — NOT routed through CachedCollectionsService's
// allow-list, since that does a full unfiltered collection().get() per entry;
// `news` fans out to thousands of docs across the whole ticker universe (one
// per ticker per article), so a flat cache-aside read there would ship the
// entire collection into memory just to show the 30-60 most recent items two
// screens actually want. This keeps its own small cache instead.
// Must cover a FULL trading day, not just the last hour or two. commentary.tsx
// splits this single response client-side into "Before the Bell" (published
// before 09:30 ET), "After the Close" (>= 16:00 ET), Macro and My Feed. At 60
// the window only ever held the newest couple of hours, so once ~60 regular-
// session stories published, every pre-market article fell out of the response
// and "Before the Bell" rendered its empty state for the rest of the day —
// even though the articles existed in Firestore. ~340KB uncompressed, ~50KB
// gzipped, behind a 2-min server cache + 120s CDN cache.
const NEWS_FEED_LIMIT = 300;
const NEWS_FEED_CACHE_MS = 2 * 60_000;
// news.job.ts's own cron runs every 30 min — ensureFresh only needs to trigger
// a refresh when nothing has synced in roughly that window, not MarketDataService's
// default 20h (built for ~daily jobs).
const NEWS_STALE_MS = 15 * 60_000;

/**
 * GET /market-data/news — the global "most recent across every ticker" feed
 * that commentary.tsx's Live tab and Dashboard's Live Market Feed both want.
 * Per-ticker news (Stock Detail, commentary's per-symbol drawer) is served by
 * GET /live/news?ticker=X (src/live/ondemand.controller.ts) instead — that's a
 * cache-aside fill against the same `news` collection, scoped to one ticker.
 */
@Controller("market-data")
// Market data is the product. These read surfaces answered anonymous
// callers, returning full datasets — the policy lived only in a Firestore
// rules file that nothing enforces, because no client talks to Firestore.
@UseGuards(FirebaseAuthGuard)
export class NewsController {
  private cache: { data: Record<string, unknown>[]; at: number } | null = null;

  constructor(
    private readonly marketData: MarketDataService,
    private readonly firebase: FirebaseAdminService,
  ) {}

  @Get("news")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=120, stale-while-revalidate=300",
  )
  async news(): Promise<Record<string, unknown>[]> {
    if (this.cache && Date.now() - this.cache.at < NEWS_FEED_CACHE_MS)
      return this.cache.data;

    await this.marketData.ensureFresh("news", NEWS_STALE_MS);
    const snap = await this.firebase.firestore
      .collection("news")
      .orderBy("publishedAt", "desc")
      .limit(NEWS_FEED_LIMIT)
      .get();
    const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    this.cache = { data, at: Date.now() };
    return data;
  }
}
