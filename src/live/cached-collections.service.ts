import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { DelistedTickersService } from "../common/delisted-tickers.service";

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
  "analyst_firm_stats",
  "ipos",
  "macro_events",
  "recaps",
  "insider_transactions",
  "institutional_ownership",
  "dividends",
  "fund_holdings",
  "filings_wire",
  "earnings_announcements",
  "ipo_pipeline",
  "macro_regime",
  "mover_catalysts",
]);

// Two-tier TTL. Almost every allow-listed collection is written ONCE PER DAY by
// the sync jobs, so a blanket 5-minute cache re-read the entire collection every
// 5 minutes per instance for zero freshness gain — and the big ones
// (earnings_events ≈ 12k docs, dividends ≈ 6k, the *_history feeds) dominated the
// Firestore read bill. Give daily-changing collections a long TTL; keep only the
// genuinely intraday-updated collections on the short one. (Live prices come from
// the snapshot/quotes path, not from these cached lists, so a longer list TTL
// does NOT make quotes stale.)
const FAST_TTL_MS = 5 * 60 * 1000; // 5 min — rewritten by the intraday sync
const SLOW_TTL_MS = 60 * 60 * 1000; // 60 min — written once/day by sync jobs

// The only collections the intraday (5-min) sync actually rewrites. Everything
// else in ALLOWED changes at most daily and uses SLOW_TTL_MS.
const FAST = new Set<string>([
  "companies",
  "market_indices",
  "market_movers",
  "market_breadth",
  "market_sentiment",
  "sectors",
]);

const RETRY_BACKOFF_MS = 30 * 1000;

const ttlFor = (name: string): number =>
  FAST.has(name) ? FAST_TTL_MS : SLOW_TTL_MS;

@Injectable()
export class CachedCollectionsService {
  private readonly logger = new Logger(CachedCollectionsService.name);
  private readonly cache = new Map<string, { data: unknown[]; at: number }>();
  private readonly inflight = new Map<string, Promise<unknown[]>>();

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly delisted: DelistedTickersService,
  ) {}

  isAllowed(name: string): boolean {
    return ALLOWED.has(name);
  }

  /**
   * Warm the intraday collections at boot so the first dashboard load doesn't
   * pay a cold full-collection read (and every concurrent caller with it).
   */
  onApplicationBootstrap(): void {
    for (const name of FAST) void this.load(name);
  }

  /**
   * One Firestore read per collection at a time: concurrent callers (the
   * dashboard fires several endpoints backed by `companies` at once) share the
   * same promise instead of each reading the whole collection. Never rejects.
   */
  private load(name: string): Promise<unknown[]> {
    const running = this.inflight.get(name);
    if (running) return running;
    const prev = this.cache.get(name);
    const run = (async () => {
      try {
        const snap = await this.firebase.firestore.collection(name).get();
        const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        this.cache.set(name, { data, at: Date.now() });
        return data;
      } catch (err) {
        // Serve stale on error if we have it; else an empty array (the client
        // falls back to its own direct Firestore read).
        this.logger.warn(
          `cached-collections read failed for ${name}: ${(err as Error).message}`,
        );
        if (prev) {
          // Retry in ~30s rather than on every request while Firestore is down.
          this.cache.set(name, {
            data: prev.data,
            at: Date.now() - ttlFor(name) + RETRY_BACKOFF_MS,
          });
        }
        return prev?.data ?? [];
      }
    })().finally(() => this.inflight.delete(name));
    this.inflight.set(name, run);
    return run;
  }

  /**
   * Fetch the requested (allow-listed) collections. Fresh → cache; stale → the
   * stale copy is served at once while a single background refresh runs; only a
   * truly cold collection makes the caller wait.
   */
  async get(names: string[]): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    await Promise.all(
      names.map(async (name) => {
        const hit = this.cache.get(name);
        if (hit && Date.now() - hit.at < ttlFor(name)) {
          out[name] = hit.data;
          return;
        }
        if (hit) {
          void this.load(name);
          out[name] = hit.data;
          return;
        }
        out[name] = await this.load(name);
      }),
    );
    // Applied on the way OUT, not to the cache, so a delisting takes effect
    // within the delisted set's own TTL rather than waiting out a 60-min list.
    for (const name of Object.keys(out)) {
      out[name] = await this.delisted.filterRows(out[name]);
    }
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
