import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { Observable, ReplaySubject } from "rxjs";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { MarketStatusService } from "./market-status.service";
import { FredService } from "../vendors/fred/fred.service";
import {
  snapshotSymbols,
  tapeUniverse,
  type TapeKind,
  type TapeSymbol,
} from "./tape-universe";

/**
 * The header ticker tape: ONE vendor request per refresh, broadcast to every
 * connected browser.
 *
 * WHY A BROADCAST AND NOT A PER-USER FETCH
 * The property that matters is that user count does not appear anywhere in the
 * upstream call path. One `setInterval` owns the only vendor request; every SSE
 * client subscribes to the same `ReplaySubject`. Ten users and ten thousand
 * users produce identical upstream traffic — see `stats.upstreamCalls` versus
 * `stats.clients`, which is the assertion the /live/stats endpoint exists to
 * make checkable.
 *
 * WHY ReplaySubject(1) AND NOT Subject
 * A browser that connects 40 seconds into a refresh window would otherwise sit
 * on an empty strip until the next poll. Replaying the last frame renders it
 * immediately, and costs one retained object.
 *
 * WHY THE POLLER IS REF-COUNTED
 * Nobody watching means nothing worth fetching. The timer starts on the first
 * SSE client and stops on the last, so an idle deployment makes zero vendor
 * calls. Same shape as the ref counting in polygon-live.service.ts and the
 * demand-driven timer in snapshot-cache.service.ts.
 *
 * WHY 60 SECONDS IS NOT A COMPROMISE
 * The plan is delayed-only; measured feed lag is ~903s (~15.05 min). A 60s
 * refresh makes the tape 960s old instead of 900s — 6.7% worse on data that is
 * already a quarter-hour stale. Polling harder would buy nothing a user could
 * perceive while multiplying upstream traffic.
 */

/** Refresh while the tape can actually move (pre, regular or post session). */
const ACTIVE_REFRESH_MS = 60_000;
/**
 * Refresh when the market is shut. Values are frozen, so this exists only to
 * notice a late correction and to recover after an outage — not to track price.
 */
const IDLE_REFRESH_MS = 15 * 60_000;
/**
 * The treasury series is DAILY. Re-fetching it every minute would be 390
 * pointless requests a day for a number that changes once.
 */
const TREASURY_TTL_MS = 6 * 60 * 60_000;
// Commodities / crypto (WTI, Gold, Bitcoin) come from FRED — the REAL price,
// not an ETF proxy. The old proxies drift far from the underlying (USO read
// ~$127 vs crude ~$82; GLD/IBIT show the fund's share price, not spot). Each
// item declares its `fredSeries` in tape-universe.ts. FRED series are daily, so
// a 6h TTL is plenty.
const FRED_TTL_MS = 6 * 60 * 60_000;

const DELAY_NOTE =
  "Underlying feed is ~15 minutes delayed on the current plan.";

/**
 * `catch (err)` binds `unknown`, and a thrown non-Error (a string, a rejected
 * promise carrying a plain object) would render as "[object Object]" in the log
 * and in `stats.lastError` — the two places someone looks when the tape has
 * gone stale. Same shape as the guard in main.ts's unhandledRejection handler.
 */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  // String() on a plain object yields the literally useless "[object Object]";
  // serialising it at least preserves whatever the thrower put in there.
  try {
    return JSON.stringify(err) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

export interface TapeItem {
  id: string;
  kind: TapeKind;
  label: string;
  /** Vendor company name where we have one — for the drawer, not the strip. */
  name: string | null;
  proxyTicker: string | null;
  isProxy: boolean;
  note: string | null;
  /** 'percent' on the rate tile only; absent on price-quoted tiles. */
  unit?: "percent";
  value: number | null;
  /**
   * ABSOLUTE move for the rate tile (basis points), PERCENT move for every
   * price tile. The UI renders this straight into the "▲ 1.24%" slot, so the
   * distinction is load-bearing — mergePulse in the frontend makes the same
   * split via `unit === 'percent'`.
   */
  change: number | null;
  pctChange: number | null;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  prevClose: number | null;
}

export interface TapeFrame {
  items: TapeItem[];
  /** When WE fetched, ISO. Not when the data is from — see vendorDelayNote. */
  asOf: string;
  vendorDelayNote: string;
  marketPhase: "open" | "pre" | "after" | "closed" | "unknown";
  /** True when the most recent refresh failed and these are the last good values. */
  stale: boolean;
}

@Injectable()
export class TapeService implements OnModuleDestroy {
  private readonly logger = new Logger(TapeService.name);

  private readonly universe: TapeSymbol[];
  private readonly snapshotTickers: string[];

  /** Replay 1 so a mid-window subscriber renders immediately. */
  private readonly frames = new ReplaySubject<TapeFrame>(1);
  private lastFrame: TapeFrame | null = null;
  /** Hash of the last broadcast frame — suppresses no-op pushes. */
  private lastHash = "";

  private clients = 0;
  private timer: NodeJS.Timeout | null = null;
  private currentIntervalMs = 0;
  private refreshing = false;
  private destroyed = false;

  private treasury: {
    value: number;
    prevValue: number | null;
    at: number;
  } | null = null;

  // FRED-backed tiles (WTI / Gold / Bitcoin), cached per series id.
  private fredCache = new Map<
    string,
    { value: number; prevValue: number | null; at: number }
  >();

  readonly stats = {
    upstreamCalls: 0,
    framesBroadcast: 0,
    suppressedFrames: 0,
    clients: 0,
    lastRefreshMs: 0,
    lastRefreshAt: "",
    lastError: "",
  };

  constructor(
    private readonly polygon: PolygonService,
    private readonly marketStatus: MarketStatusService,
    private readonly fred: FredService,
    config: ConfigService,
  ) {
    this.universe = tapeUniverse(config.get<string>("TAPE_STOCKS"));
    this.snapshotTickers = snapshotSymbols(this.universe);
  }

  onModuleDestroy() {
    this.destroyed = true;
    this.stopTimer();
    this.frames.complete();
  }

  /** The broadcast stream. Every SSE client shares this one observable. */
  get frames$(): Observable<TapeFrame> {
    return this.frames.asObservable();
  }

  get lastKnownFrame(): TapeFrame | null {
    return this.lastFrame;
  }

  /**
   * Registers a viewer. The FIRST one starts the poller and triggers an
   * immediate refresh so it does not wait a full interval for the first frame.
   */
  addClient(): void {
    this.clients++;
    this.stats.clients = this.clients;
    if (this.clients === 1) {
      this.ensureTimer();
      if (!this.lastFrame) void this.refresh();
    }
  }

  /** Releases a viewer. The LAST one stops the poller — no viewers, no calls. */
  removeClient(): void {
    this.clients = Math.max(0, this.clients - 1);
    this.stats.clients = this.clients;
    if (this.clients === 0) this.stopTimer();
  }

  /**
   * Fetches on demand for the plain-JSON endpoint, which has no long-lived
   * connection to ref-count against. Returns the cached frame when one is fresh
   * enough, so a burst of JSON requests cannot become a burst of vendor calls.
   */
  async currentFrame(): Promise<TapeFrame> {
    const age = this.lastFrame
      ? Date.now() - Date.parse(this.lastFrame.asOf)
      : Infinity;
    if (!this.lastFrame || age > ACTIVE_REFRESH_MS) await this.refresh();
    return (
      this.lastFrame ?? {
        items: [],
        asOf: new Date().toISOString(),
        vendorDelayNote: DELAY_NOTE,
        marketPhase: "unknown",
        stale: true,
      }
    );
  }

  private ensureTimer(intervalMs = ACTIVE_REFRESH_MS) {
    if (this.destroyed) return;
    if (this.timer && this.currentIntervalMs === intervalMs) return;
    this.stopTimer();
    this.currentIntervalMs = intervalMs;
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    // Node keeps the process alive for a pending timer. This one is a
    // background poller, not work anybody is waiting on, so it must not hold
    // the process open during a graceful shutdown.
    this.timer.unref?.();
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.currentIntervalMs = 0;
  }

  /**
   * THE one upstream call. Note what is absent from this function: any notion
   * of who is connected or how many of them there are.
   */
  private async refresh(): Promise<void> {
    if (this.refreshing || this.destroyed) return;
    this.refreshing = true;
    const started = Date.now();
    try {
      const phase = await this.phase();

      // ZERO-poll when closed (2026-07-26): with the market closed and a
      // non-stale frame already captured, prices cannot move — skip the vendor
      // entirely. The timer keeps ticking (15-min cadence) only to re-check
      // the phase, so the tape resumes by itself at the next session open.
      if (phase === "closed" && this.lastFrame && !this.lastFrame.stale) {
        if (this.clients > 0) this.ensureTimer(IDLE_REFRESH_MS);
        return;
      }

      // One request for every equity on the tape — indices proxies and
      // mega-caps together. `ticker.any_of` is what makes this O(1) in the
      // number of symbols instead of one call each.
      const rows = await this.polygon.getUniversalSnapshot(
        this.snapshotTickers,
      );
      this.stats.upstreamCalls++;
      const bySymbol = new Map(rows.map((r) => [r.ticker, r]));

      const rate = await this.treasuryTile();
      // Refresh every FRED-backed series (WTI / Gold / Bitcoin) — real prices,
      // not ETF proxies. TTL-gated, so this is at most one call per series / 6h.
      await Promise.all(
        [
          ...new Set(
            this.universe
              .map((s) => s.fredSeries)
              .filter((x): x is string => !!x),
          ),
        ].map((series) => this.refreshFred(series)),
      );

      const items: TapeItem[] = this.universe.map((s) => {
        if (s.kind === "rate") return rate(s);
        if (s.fredSeries) return this.fredTile(s); // real price from FRED, not an ETF proxy
        const r = s.proxyTicker ? bySymbol.get(s.proxyTicker) : undefined;
        // Index-level fields scale by the proxy ETF's fixed share-to-index
        // ratio (see TapeSymbol.multiplier's docblock); % change is
        // scale-invariant and is left as the ETF's own move.
        const mult = s.multiplier ?? 1;
        return {
          id: s.id,
          kind: s.kind,
          label: s.label,
          name: r?.name ?? null,
          proxyTicker: s.proxyTicker,
          isProxy: s.isProxy,
          note: s.note,
          value: r?.price != null ? r.price * mult : null,
          // Price tiles render a PERCENT move, matching what the strip has
          // always shown and what mergePulse feeds the index drawer.
          change: r?.changePercent ?? null,
          pctChange: r?.changePercent ?? null,
          open: r?.open != null ? r.open * mult : null,
          dayHigh: r?.high != null ? r.high * mult : null,
          dayLow: r?.low != null ? r.low * mult : null,
          prevClose: r?.previousClose != null ? r.previousClose * mult : null,
        };
      });

      this.stats.lastRefreshMs = Date.now() - started;
      this.stats.lastRefreshAt = new Date().toISOString();
      this.stats.lastError = "";
      this.publish({
        items,
        asOf: new Date().toISOString(),
        vendorDelayNote: DELAY_NOTE,
        marketPhase: phase,
        stale: false,
      });

      // Retune the cadence to the session. Doing it here rather than on a
      // separate schedule means the interval follows the vendor's own view of
      // the session, including early closes and halts.
      if (this.clients > 0) {
        this.ensureTimer(
          phase === "closed" ? IDLE_REFRESH_MS : ACTIVE_REFRESH_MS,
        );
      }
    } catch (err) {
      // Stale beats blank. The previous values are far more useful than an
      // empty strip on a feed that is already 15 minutes behind — the same
      // rule snapshot-cache.service.ts and market-status.service.ts follow.
      this.stats.lastError = errMessage(err);
      this.logger.warn(`tape refresh failed: ${errMessage(err)}`);
      if (this.lastFrame && !this.lastFrame.stale) {
        this.publish({ ...this.lastFrame, stale: true });
      }
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Broadcasts only when something changed. Overnight and at weekends the
   * numbers are frozen, so without this every connected browser would receive
   * an identical multi-KB frame every 15 minutes for no reason.
   */
  private publish(frame: TapeFrame) {
    // asOf changes every refresh by construction, so it is excluded from the
    // hash — otherwise nothing would ever compare equal and the check would be
    // dead code that still costs a sha1 per refresh.
    const hash = createHash("sha1")
      .update(
        JSON.stringify({
          items: frame.items,
          phase: frame.marketPhase,
          stale: frame.stale,
        }),
      )
      .digest("hex");
    this.lastFrame = frame;
    if (hash === this.lastHash) {
      this.stats.suppressedFrames++;
      return;
    }
    this.lastHash = hash;
    this.stats.framesBroadcast++;
    this.frames.next(frame);
  }

  private async phase(): Promise<TapeFrame["marketPhase"]> {
    try {
      return (await this.marketStatus.get()).phase;
    } catch {
      // A market-status outage must not take the price tape down with it.
      return "unknown";
    }
  }

  /**
   * The 10Y tile, cached for 6 hours. Returns a builder rather than an item so
   * the caller keeps the tape ordering in one place.
   *
   * `change` here is a BASIS-POINT move, not a percentage: yields are quoted in
   * percentage points, so 4.55 -> 4.53 is -0.02, not -0.44%. `unit: 'percent'`
   * is what tells the UI to render it that way.
   */
  private async treasuryTile(): Promise<(s: TapeSymbol) => TapeItem> {
    const now = Date.now();
    if (!this.treasury || now - this.treasury.at > TREASURY_TTL_MS) {
      try {
        const curve = await this.polygon.getTreasuryYields(2);
        this.stats.upstreamCalls++;
        const latest = curve[0]?.yield10Year ?? null;
        if (latest != null) {
          this.treasury = {
            value: latest,
            prevValue: curve[1]?.yield10Year ?? null,
            at: now,
          };
        }
      } catch (err) {
        // Keep whatever we had; a stale yield beats dropping the tile.
        this.logger.warn(`treasury yield refresh failed: ${errMessage(err)}`);
      }
    }

    const t = this.treasury;
    return (s) => {
      const value = t?.value ?? null;
      const prev = t?.prevValue ?? null;
      const change =
        value == null || prev == null
          ? null
          : Math.round((value - prev) * 1000) / 1000;
      return {
        id: s.id,
        kind: s.kind,
        label: s.label,
        name: null,
        proxyTicker: null,
        isProxy: false,
        note: s.note,
        unit: "percent",
        value,
        change,
        pctChange:
          prev && prev !== 0 && change != null
            ? Math.round(((value - prev) / prev) * 10000) / 100
            : null,
        open: null,
        dayHigh: null,
        dayLow: null,
        prevClose: prev,
      };
    };
  }

  /**
   * WTI crude tile from FRED (DCOILWTICO) — the true spot price. Mirrors
   * `treasuryTile()`: a TTL cache over a daily FRED series, so at most one FRED
   * call every 6h regardless of frame rate. FRED sometimes reports "." for a
   * missing day, so we pull a small window and keep the two most recent numeric
   * observations for the value + day-over-day change.
   */
  /** Refresh one FRED series into the cache (TTL-gated). Keeps the last good
   * value on failure — a stale real print beats dropping the tile. */
  private async refreshFred(series: string): Promise<void> {
    const cached = this.fredCache.get(series);
    if (cached && Date.now() - cached.at <= FRED_TTL_MS) return;
    try {
      const obs = await this.fred.getLatestObservations(series, 6);
      this.stats.upstreamCalls++;
      const vals = obs
        .map((o) => Number(o.value))
        .filter((n) => Number.isFinite(n));
      if (vals.length > 0) {
        this.fredCache.set(series, {
          value: vals[0],
          prevValue: vals.length > 1 ? vals[1] : null,
          at: Date.now(),
        });
      }
    } catch (err) {
      this.logger.warn(`FRED ${series} refresh failed: ${errMessage(err)}`);
    }
  }

  /** Build a tile for a FRED-backed symbol (real spot price, not an ETF proxy). */
  private fredTile(s: TapeSymbol): TapeItem {
    const c = s.fredSeries ? this.fredCache.get(s.fredSeries) : undefined;
    const value = c?.value ?? null;
    const prev = c?.prevValue ?? null;
    const pct =
      value != null && prev != null && prev !== 0
        ? Math.round(((value - prev) / prev) * 10000) / 100
        : null;
    return {
      id: s.id,
      kind: s.kind,
      label: s.label,
      name: null,
      proxyTicker: null,
      isProxy: false,
      note: s.note,
      value,
      change: pct,
      pctChange: pct,
      open: null,
      dayHigh: null,
      dayLow: null,
      prevClose: prev,
    };
  }

  /** Weak ETag over a frame, for the plain-JSON endpoint. */
  etagFor(frame: TapeFrame): string {
    const h = createHash("sha1")
      .update(JSON.stringify(frame.items))
      .digest("hex")
      .slice(0, 16);
    return `W/"${h}"`;
  }
}
