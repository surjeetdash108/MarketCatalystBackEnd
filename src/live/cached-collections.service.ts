import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * Server-side cache of the SHARED, slow-changing Firestore collections that the
 * whole app reads (dashboard indices/movers/sectors/breadth/sentiment, earnings,
 * ipos, macro, recaps, …). These are written once per day by the sync jobs, so a
 * few-minute cache is plenty fresh.
 *
 * WHY THIS EXISTS
 * The browser used to open a Firestore `onSnapshot` per collection, per user, so
 * Firestore reads scaled as (users × documents) — the one line item that would
 * push the bill over budget as user count grows. Serving these collections from
 * one in-memory cache here makes reads scale with (instances × refreshes), i.e.
 * INDEPENDENT of user count. 10 users or 10,000, the backend reads each
 * collection at most once per TTL per instance.
 *
 * Only an allow-listed set is cacheable — never user-owned/private paths
 * (watchlists, holdings, settings), which stay on the direct Firestore SDK.
 */

const ALLOWED = new Set<string>([
  "companies",
  "market_indices",
  "market_indices_history",
  "market_movers",
  "market_movers_history",
  "sectors",
  "sectors_history",
  "market_breadth",
  "market_sentiment",
  "market_sentiment_history",
  "earnings_events",
  "analyst_actions",
  "ipos",
  "macro_events",
  "recaps",
  "insider_transactions",
  "dividends",
  "fund_holdings",
  "filings_wire",
  "earnings_announcements",
  "ipo_pipeline",
  "macro_regime",
]);

const TTL_MS = 5 * 60 * 1000; // 5 minutes — these collections change daily

@Injectable()
export class CachedCollectionsService {
  private readonly logger = new Logger(CachedCollectionsService.name);
  private readonly cache = new Map<string, { data: unknown[]; at: number }>();

  constructor(private readonly firebase: FirebaseAdminService) {}

  isAllowed(name: string): boolean {
    return ALLOWED.has(name);
  }

  /** Fetch the requested (allow-listed) collections, from cache when fresh. */
  async get(names: string[]): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    await Promise.all(
      names.map(async (name) => {
        const hit = this.cache.get(name);
        if (hit && Date.now() - hit.at < TTL_MS) {
          out[name] = hit.data;
          return;
        }
        try {
          const snap = await this.firebase.firestore.collection(name).get();
          const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          this.cache.set(name, { data, at: Date.now() });
          out[name] = data;
        } catch (err) {
          // Serve stale on error if we have it; else an empty array (the client
          // falls back to its own direct Firestore read).
          this.logger.warn(
            `cached-collections read failed for ${name}: ${(err as Error).message}`,
          );
          out[name] = hit?.data ?? [];
        }
      }),
    );
    return out;
  }

  etagFor(obj: unknown): string {
    return (
      'W/"' +
      createHash("sha1")
        .update(JSON.stringify(obj))
        .digest("hex")
        .slice(0, 20) +
      '"'
    );
  }
}
