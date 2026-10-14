import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { createHash } from "crypto";
import { ConfigService } from "@nestjs/config";
import { fetchJson } from "../common/http.util";
import {
  FmpService,
  type FmpExtendedTrade,
  type FmpFullQuote,
} from "../vendors/fmp/fmp.service";

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
 *
 * VENDOR SWITCH (LIVE_QUOTE_SOURCE / LIVE_QUOTE_FALLBACK_SOURCE)
 * `LIVE_QUOTE_SOURCE=polygon` (default) or `fmp` picks who fills this cache;
 * revert is an env change, no code. `LIVE_QUOTE_FALLBACK_SOURCE` (default
 * `none`) fills only the tickers the primary failed to price. Deliberately NOT
 * `QUOTE_SOURCE` — that one belongs to QUOTE_ADAPTER (market-indices job) in
 * adapters.module.ts, which is Polygon-only and throws on `fmp` at boot.
 * Caveats of `fmp`:
 *   - One `/stable/batch-quote` call per refresh (verified on the current plan
 *     2026-09-28, quotes ~seconds old vs Polygon's ~15 min). If a plan ever
 *     loses batch-quote it degrades to ONE CALL PER TICKER per refresh, paced
 *     through FmpService's shared queue, slowing other FMP callers.
 *   - FMP's quote has no VWAP or last-minute bar; those fields are null.
 *   - FMP's quote is regular-session only, so outside regular hours one more
 *     batch call (`batch-aftermarket-trade`) supplies the pre/post-market
 *     price, and `mapFmpQuote` lays it out in Polygon's session semantics.
 */

type QuoteSource = "polygon" | "fmp" | "none";

function parseSource(
  raw: string | undefined,
  fallback: QuoteSource,
): QuoteSource {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "polygon" || v === "fmp" || v === "none" ? v : fallback;
}

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
  /**
   * The latest REGULAR-session close (16:00 ET), as distinct from `price`,
   * which off-hours is the last extended-hours trade. The after-hours move is
   * measured from this; without it the client had to reconstruct it from the
   * vendor's late-trading percentage, which in pre-market still holds the
   * PREVIOUS evening's figure (GS on 13 Oct: +0.48% from 12 Oct shown beside
   * a 13 Oct pre-market price). From FMP it is the quote's regular-session
   * price (see mapFmpQuote).
   */
  regularClose: number | null;
  /** "open" | "closed" | "early_trading" | "late_trading" per the vendor. */
  marketStatus: string | null;
}

interface CacheEntry {
  quote: SnapshotQuote;
  fetchedAt: number;
}

/** ET calendar date (YYYY-MM-DD), weekday (0=Sun) and minutes since midnight. */
function etClock(ms: number): {
  date: string;
  weekday: number;
  minutes: number;
} {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      p.weekday,
    ),
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
  };
}

const PRE_OPEN = 4 * 60;
const REG_OPEN = 9 * 60 + 30;
const REG_CLOSE = 16 * 60;
const AFTER_END = 20 * 60;

/** The FMP quote's session, in Polygon's `market_status` vocabulary. */
export type FmpSession = "open" | "early_trading" | "late_trading" | "closed";

/**
 * Which session an FMP quote is in. Keyed on the quote's own print date as well
 * as the clock, so a holiday (no print today) never reads as "open".
 */
export function fmpSession(q: FmpFullQuote, now: number): FmpSession {
  const n = etClock(now);
  const weekday = n.weekday >= 1 && n.weekday <= 5;
  const printedToday =
    q.timestamp != null && etClock(q.timestamp * 1000).date === n.date;
  if (weekday && printedToday && n.minutes >= REG_OPEN && n.minutes < REG_CLOSE)
    return "open";
  if (weekday && n.minutes >= PRE_OPEN && n.minutes < REG_OPEN)
    return "early_trading";
  if (
    weekday &&
    printedToday &&
    n.minutes >= REG_CLOSE &&
    n.minutes < AFTER_END
  )
    return "late_trading";
  return "closed";
}

/**
 * Lays an FMP quote (+ its latest extended-hours trade) out in the SAME field
 * semantics as Polygon's snapshot, so the UI's session logic works unchanged
 * whichever vendor filled the cache:
 *
 *   open           the regular quote as-is; regularClose = price.
 *   early_trading  previousClose = regularClose = the last close (FMP's
 *                  quote.price before the open); price = today's pre-market
 *                  trade, change measured from that close. A trade from before
 *                  04:00 today is last evening's after-hours print and is NOT
 *                  passed off as pre-market — the price stays at the close.
 *   late_trading / closed
 *                  regularClose = the session's close (quote.price),
 *                  previousClose = the one before; price = an after-hours
 *                  trade made after that close, if any. change is from
 *                  previousClose (Polygon's convention); the after-hours move
 *                  alone is lateTradingChangePct.
 *
 * Previously FMP sent no session at all: before the open the cache priced
 * every ticker at yesterday's close, and during regular hours the UI, finding
 * no market status, tagged every moving stock "EXT".
 */
export function mapFmpQuote(
  q: FmpFullQuote,
  trade: FmpExtendedTrade | undefined,
  now: number,
): SnapshotQuote {
  const session = fmpSession(q, now);
  const base: SnapshotQuote = {
    ticker: q.symbol,
    price: q.price,
    change: q.change,
    changePct: q.changePercentage,
    previousClose: q.previousClose,
    open: q.open,
    dayHigh: q.dayHigh,
    dayLow: q.dayLow,
    dayVolume: q.volume,
    dayVwap: null,
    minuteClose: null,
    minuteAt: null,
    // FMP quote timestamps are Unix SECONDS (Polygon's are nanoseconds).
    vendorUpdatedAt: q.timestamp != null ? q.timestamp * 1000 : null,
    earlyTradingChangePct: null,
    lateTradingChangePct: null,
    regularTradingChangePct: q.changePercentage,
    regularClose: q.price,
    marketStatus: session,
  };
  const pct = (a: number, b: number | null) =>
    b != null && b !== 0 ? ((a - b) / b) * 100 : null;
  if (session === "open" || q.price == null) return base;

  if (session === "early_trading") {
    const close = q.price;
    const t = trade ? etClock(trade.at) : null;
    const preTrade =
      trade && t && t.date === etClock(now).date && t.minutes >= PRE_OPEN
        ? trade
        : undefined;
    const price = preTrade?.price ?? close;
    return {
      ...base,
      price,
      change: price - close,
      changePct: pct(price, close),
      previousClose: close,
      regularClose: close,
      earlyTradingChangePct: preTrade ? pct(price, close) : null,
      // No regular session has run yet today (Polygon reports none either).
      regularTradingChangePct: null,
      vendorUpdatedAt: preTrade?.at ?? base.vendorUpdatedAt,
    };
  }

  // late_trading / closed: only a trade made after this session's close counts.
  const closedAt = q.timestamp != null ? q.timestamp * 1000 : null;
  const afterTrade =
    trade && closedAt != null && trade.at > closedAt ? trade : undefined;
  if (!afterTrade) return base;
  const price = afterTrade.price;
  return {
    ...base,
    price,
    change: q.previousClose != null ? price - q.previousClose : null,
    changePct: pct(price, q.previousClose),
    lateTradingChangePct: pct(price, q.price),
    vendorUpdatedAt: afterTrade.at,
  };
}

@Injectable()
export class SnapshotCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(SnapshotCacheService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly refreshMs: number;
  /** Which vendor fills the cache; read by the controller to label responses. */
  readonly source: QuoteSource;
  private readonly fallbackSource: QuoteSource;

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

  constructor(
    private readonly config: ConfigService,
    private readonly fmp: FmpService,
  ) {
    this.source = parseSource(
      this.config.get<string>("LIVE_QUOTE_SOURCE"),
      "polygon",
    );
    const fb = parseSource(
      this.config.get<string>("LIVE_QUOTE_FALLBACK_SOURCE"),
      "none",
    );
    this.fallbackSource = fb === this.source ? "none" : fb;
    this.logger.log(
      `live quotes: source=${this.source} fallback=${this.fallbackSource}`,
    );
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
   * (Under LIVE_QUOTE_SOURCE=fmp without batch-quote it is N calls — see top.)
   */
  private async refresh(tickers: string[]): Promise<void> {
    const primaryOk = this.canFetch(this.source);
    if (
      tickers.length === 0 ||
      this.refreshing ||
      (!primaryOk && !this.canFetch(this.fallbackSource))
    ) {
      return;
    }
    this.refreshing = true;
    const started = Date.now();
    try {
      let quotes: SnapshotQuote[] = [];
      let primaryErr: Error | null = null;
      // A primary with no key (e.g. LIVE_QUOTE_SOURCE=fmp on a service missing the
      // FMP_API_KEY secret) is skipped, so the fallback serves every ticker
      // instead of the cache silently staying empty.
      if (primaryOk) {
        try {
          quotes = await this.fetchFrom(this.source, tickers);
        } catch (err) {
          primaryErr = err as Error;
        }
      }

      // The fallback fills only what the primary could not price, so a healthy
      // primary never has its numbers overwritten by a second vendor.
      const got = new Set(quotes.map((q) => q.ticker));
      const missing = tickers.filter((t) => !got.has(t));
      if (missing.length > 0 && this.canFetch(this.fallbackSource)) {
        try {
          quotes = quotes.concat(
            await this.fetchFrom(this.fallbackSource, missing),
          );
        } catch (err) {
          this.logger.warn(
            `snapshot fallback (${this.fallbackSource}) failed: ${(err as Error).message}`,
          );
        }
      }
      if (primaryErr && quotes.length === 0) throw primaryErr;

      const now = Date.now();
      for (const q of quotes) {
        this.cache.set(q.ticker, { quote: q, fetchedAt: now });
      }
      this.stats.lastRefreshMs = Date.now() - started;
      this.stats.lastError = primaryErr
        ? `${this.source}: ${primaryErr.message}`
        : "";
    } catch (err) {
      // Keep serving stale data rather than blanking the UI — the previous
      // value is far more useful than nothing on a delayed feed.
      this.stats.lastError = err.message;
      this.logger.warn(`snapshot refresh failed: ${err.message}`);
    } finally {
      this.refreshing = false;
    }
  }

  private canFetch(source: QuoteSource): boolean {
    if (source === "polygon") return !!this.apiKey;
    if (source === "fmp") return this.fmp.enabled;
    return false;
  }

  private async fetchFrom(
    source: QuoteSource,
    tickers: string[],
  ): Promise<SnapshotQuote[]> {
    if (source === "fmp") {
      const batched = this.fmp.batchQuoteSupported;
      const rows = await this.fmp.getQuotes(tickers);
      // Honest accounting: without batch-quote every ticker is its own call.
      this.stats.upstreamCalls += batched ? 1 : tickers.length;
      // Outside regular hours the quote is still the close; one batch call
      // fetches the extended-hours trades that move the price off it.
      const now = Date.now();
      const extended = rows
        .filter((q) => fmpSession(q, now) !== "open")
        .map((q) => q.symbol);
      const trades = new Map<string, FmpExtendedTrade>();
      if (extended.length > 0) {
        for (const t of await this.fmp.getExtendedTrades(extended)) {
          trades.set(t.symbol, t);
        }
        this.stats.upstreamCalls++;
      }
      return rows.map((q) => mapFmpQuote(q, trades.get(q.symbol), now));
    }
    if (source !== "polygon") return [];

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
    return (res.results ?? []).map((t) => this.map(t));
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
    const vendorPrice = num(s.price);
    const prev = num(s.previous_close);
    const price = vendorPrice ?? num(min.close) ?? prev;
    // The change has to describe the price we are actually returning.
    //
    // The vendor computes change/change_percent against ITS OWN last price. If
    // that price is missing and we fall back to the minute bar or the previous
    // close, keeping the vendor's percentage pairs a number with a price it was
    // never derived from — and the row contradicts itself. AEHL rendered $6.34
    // at +93.14% when, against the same previous close of 3.54, $6.34 is
    // +79.1%; +93.14% belonged to a $6.84 print we were not showing.
    //
    // So the percentage is the vendor's only when the price is too. Otherwise
    // it is recomputed from the price we chose, which may lag but can never be
    // arithmetically wrong about the number printed beside it.
    const paired = vendorPrice != null;
    const canDerive = price != null && prev != null && prev !== 0;
    return {
      ticker: t.ticker,
      price,
      change: paired ? num(s.change) : canDerive ? price - prev : null,
      changePct: paired
        ? num(s.change_percent)
        : canDerive
          ? ((price - prev) / prev) * 100
          : null,
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
      regularClose: num(s.close),
      marketStatus: t.market_status ?? null,
    };
  }
}
