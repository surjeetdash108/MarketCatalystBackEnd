import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { createHash } from "crypto";
import { ConfigService } from "@nestjs/config";
import { fetchJson } from "../common/http.util";

/**
 * O(1)-upstream price cache: one vendor call per refresh interval, regardless
 * of how many users are connected.
 *
 * WHY THIS EXISTS
 * The WebSocket path (polygon-live.service.ts) cannot scale past one instance:
 * Polygon permits a single concurrent socket per API key, while Cloud Run caps
 * long-lived requests at 80 per instance — so 10k users would need ~125
 * instances, of which only one could hold the socket. Measured cost of the
 * streaming path was ~156 KB of RSS per connected client.
 *
 * Polling a shared cache has none of those properties:
 *   - upstream load is constant (1 call / REFRESH_MS) whether 1 or 100k users
 *   - every instance can serve, because nothing is pinned to a socket
 *   - responses are identical per interval, so a CDN collapses them to ~1
 *     origin request per interval
 *
 * And it costs almost nothing in freshness: the underlying feed is already
 * ~15 minutes delayed, so a 10-second refresh makes data 910s old instead of
 * 900s — under 2% worse, for ~1% of the infrastructure.
 */

const REFRESH_MS_DEFAULT = 10_000;
/** Drop a ticker from the refresh set after this long with no requests. */
const IDLE_EVICT_MS = 5 * 60_000;
/** Guard against an unbounded refresh set if callers request wildly. */
const MAX_TRACKED = 200;

/** True during US extended trading (04:00–20:00 ET weekdays) — the only window
 *  in which a delayed-quote refresh can return something new. */
function inExtendedSession(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "numeric",
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "12") % 24;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  return weekday >= 1 && weekday <= 5 && hour >= 4 && hour < 20;
}

export interface SnapshotQuote {
  ticker: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  previousClose: number | null;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  dayVwap: number | null;
  /** Last minute-bar close and its timestamp (epoch ms). */
  minuteClose: number | null;
  minuteAt: number | null;
  /** Vendor's own "updated" clock (epoch ms), converted from nanoseconds. */
  vendorUpdatedAt: number | null;
  /**
   * Extended-hours moves. The Premarket and After-Hours feeds rendered
   * hardcoded copy ("NVDA AH +7.1%") because the per-ticker v2 snapshot carries
   * no session breakdown. The v3 universal snapshot does, on this same plan.
   * Null outside the relevant session.
   */
  earlyTradingChangePct: number | null;
  lateTradingChangePct: number | null;
  regularTradingChangePct: number | null;
  /** "open" | "closed" | "early_trading" | "late_trading" per the vendor. */
  marketStatus: string | null;
}

interface CacheEntry {
  quote: SnapshotQuote;
  fetchedAt: number;
}

@Injectable()
export class SnapshotCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(SnapshotCacheService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly refreshMs: number;

  private readonly cache = new Map<string, CacheEntry>();
  /** ticker -> last time a client asked for it; drives the refresh set. */
  private readonly demand = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing = false;

  /** Observability: proves upstream load is decoupled from user count. */
  readonly stats = {
    upstreamCalls: 0,
    servedRequests: 0,
    lastRefreshMs: 0,
    lastError: "",
  };

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get("POLYGON_API_KEY", "");
    this.baseUrl = this.config
      .get("POLYGON_API_BASE_URL", "https://api.polygon.io")
      .replace(/\/$/, "");
    const raw = String(this.config.get("SNAPSHOT_REFRESH_MS", "")).trim();
    const parsed = raw === "" ? NaN : Number(raw);
    this.refreshMs =
      Number.isFinite(parsed) && parsed > 0 ? parsed : REFRESH_MS_DEFAULT;
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Serves from cache and registers demand. Never calls the vendor inline —
   * a request must not be able to trigger an upstream call, or 10k concurrent
   * cold requests would produce 10k upstream calls (a cache stampede).
   */
  async get(
    tickers: string[],
  ): Promise<{ quotes: SnapshotQuote[]; ageMs: number }> {
    const now = Date.now();
    this.stats.servedRequests++;

    let added = false;
    for (const t of tickers) {
      if (!this.demand.has(t) && this.demand.size < MAX_TRACKED) added = true;
      this.demand.set(t, now);
    }

    this.ensureTimer();
    // First-ever request for a ticker has nothing cached; fetch once so the
    // caller is not handed an empty result on a cold start. Subsequent calls
    // are served from cache by the timer.
    if (added || tickers.some((t) => !this.cache.has(t))) {
      await this.refresh(tickers.filter((t) => !this.cache.has(t)));
    }

    const quotes = tickers
      .map((t) => this.cache.get(t))
      .filter((e): e is CacheEntry => !!e)
      .map((e) => e.quote);

    // Re-read the clock: a cold-start refresh above may have written entries
    // AFTER `now` was captured, which made ageMs come out negative.
    const settled = Date.now();
    const oldest = tickers
      .map((t) => this.cache.get(t)?.fetchedAt)
      .filter((v): v is number => typeof v === "number");
    const ageMs = oldest.length
      ? Math.max(0, settled - Math.min(...oldest))
      : 0;

    return { quotes, ageMs };
  }

  /** Weak ETag over the payload, so unchanged intervals return 304. */
  etagFor(quotes: SnapshotQuote[]): string {
    const h = createHash("sha1")
      .update(JSON.stringify(quotes))
      .digest("hex")
      .slice(0, 16);
    return `W/"${h}"`;
  }

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [t, last] of this.demand) {
        if (now - last > IDLE_EVICT_MS) {
          this.demand.delete(t);
          this.cache.delete(t);
        }
      }
      if (this.demand.size === 0) {
        clearInterval(this.timer);
        this.timer = null;
        return;
      }
      // ZERO-poll when closed (2026-07-26): outside the extended session
      // (04:00–20:00 ET weekdays) prices cannot change, so the vendor is not
      // called AT ALL — cached frozen-at-close quotes are served. The one
      // exception is a cold start (instance restarted after hours, cache
      // empty): fetch once so users see the close, then go silent. Polling
      // resumes by itself at the next session because this clock check runs
      // every tick locally, costing no network.
      const demanded = [...this.demand.keys()];
      if (!inExtendedSession()) {
        const uncached = demanded.filter((t) => !this.cache.has(t));
        if (uncached.length === 0) return;
        void this.refresh(uncached);
        return;
      }
      void this.refresh(demanded);
    }, this.refreshMs);
  }

  /**
   * One upstream call for every tracked ticker. The whole point: N tickers cost
   * one request, and user count does not appear in this function at all.
   */
  private async refresh(tickers: string[]): Promise<void> {
    if (tickers.length === 0 || this.refreshing || !this.apiKey) return;
    this.refreshing = true;
    const started = Date.now();
    try {
      const list = tickers.join(",");
      // v3 universal snapshot rather than the v2 per-ticker one. Same plan, same
      // delay, same single call for N tickers — but it also carries the
      // early/late trading session breakdown and the last minute bar, so the
      // extended-hours figures no longer need a second endpoint.
      const url =
        `${this.baseUrl}/v3/snapshot` +
        `?ticker.any_of=${encodeURIComponent(list)}&limit=250&apiKey=${this.apiKey}`;
      const res = await fetchJson<{ results?: any[] }>(url);
      this.stats.upstreamCalls++;

      const now = Date.now();
      for (const t of res.results ?? []) {
        this.cache.set(t.ticker, { quote: this.map(t), fetchedAt: now });
      }
      this.stats.lastRefreshMs = Date.now() - started;
      this.stats.lastError = "";
    } catch (err) {
      // Keep serving stale data rather than blanking the UI — the previous
      // value is far more useful than nothing on a delayed feed.
      this.stats.lastError = err.message;
      this.logger.warn(`snapshot refresh failed: ${err.message}`);
    } finally {
      this.refreshing = false;
    }
  }

  private map(t: any): SnapshotQuote {
    const s = t.session ?? {};
    const min = t.last_minute ?? {};
    // `last_updated` is NANOSECONDS since epoch on this endpoint; dividing by
    // 1e6 yields ms. Treating it as ms would place it ~56,000 years ahead.
    const toMs = (v: unknown) =>
      typeof v === "number" ? Math.round(v / 1e6) : null;
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    // `session.price` is the vendor's own resolved last price; fall back to the
    // last minute bar and then the previous close for a pre-open request.
    const price = num(s.price) ?? num(min.close) ?? num(s.previous_close);
    return {
      ticker: t.ticker,
      price,
      change: num(s.change),
      changePct: num(s.change_percent),
      previousClose: num(s.previous_close),
      open: num(s.open),
      dayHigh: num(s.high),
      dayLow: num(s.low),
      dayVolume: num(s.volume),
      dayVwap: num(s.vwap),
      minuteClose: num(min.close),
      minuteAt: toMs(min.last_updated),
      vendorUpdatedAt: toMs(s.last_updated),
      earlyTradingChangePct: num(s.early_trading_change_percent),
      lateTradingChangePct: num(s.late_trading_change_percent),
      regularTradingChangePct: num(s.regular_trading_change_percent),
      marketStatus: t.market_status ?? null,
    };
  }
}
