import {
  BadRequestException,
  Controller,
  Logger,
  Query,
  Sse,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Observable,
  catchError,
  concat,
  distinctUntilChanged,
  exhaustMap,
  filter,
  from,
  map,
  merge,
  of,
  share,
  take,
  timer,
} from "rxjs";
import { PolygonLiveService } from "./polygon-live.service";
import {
  SnapshotCacheService,
  type SnapshotQuote,
} from "./snapshot-cache.service";

/**
 * Server-Sent Events bridge: browser <- our origin <- upstream price source.
 *
 * SSE rather than a second WebSocket because this stream is strictly one-way
 * (server -> browser). SSE is plain HTTP, reconnects automatically in the
 * browser via EventSource, and needs no extra protocol on either end.
 *
 * The browser sends only a ticker symbol. It never sees a vendor key.
 *
 * SOURCE (LIVE_STREAM_SOURCE)
 *   polygon (default) — Polygon's delayed WebSocket (polygon-live.service.ts).
 *                       One socket per API key, ~15 min delayed.
 *   fmp               — ticks read from the shared quote cache
 *                       (snapshot-cache.service.ts, filled by FMP when
 *                       LIVE_QUOTE_SOURCE=fmp). No socket is opened; upstream
 *                       cost is the cache's one batch call per refresh no
 *                       matter how many clients stream. Tick cadence is the
 *                       cache refresh (SNAPSHOT_REFRESH_MS), not per-second.
 * Same event names and payload shape either way, so the client is unchanged;
 * fields FMP has no equivalent for (vwap, sessionVwap) are sent as null.
 */

type StreamSource = "polygon" | "fmp";

/** How often each fmp-mode stream re-reads the (in-memory) quote cache. */
const CACHE_POLL_MS_DEFAULT = 5_000;

interface SseEvent {
  data: Record<string, unknown>;
  type: string;
}

/** Symbols only — this value is interpolated into an upstream subscription. */
const TICKER_RE = /^[A-Z.]{1,10}$/;

@Controller("live")
export class LiveController {
  private readonly logger = new Logger(LiveController.name);
  private readonly source: StreamSource;
  private readonly pollMs: number;

  constructor(
    private readonly live: PolygonLiveService,
    private readonly snapshots: SnapshotCacheService,
    config: ConfigService,
  ) {
    const raw = (config.get<string>("LIVE_STREAM_SOURCE") ?? "")
      .trim()
      .toLowerCase();
    this.source = raw === "fmp" ? "fmp" : "polygon";
    const poll = Number(config.get<string>("LIVE_STREAM_POLL_MS"));
    this.pollMs = Number.isFinite(poll) && poll > 0 ? poll : CACHE_POLL_MS_DEFAULT;
    this.logger.log(`live stream: source=${this.source}`);
    if (this.source === "fmp" && this.snapshots.source !== "fmp") {
      this.logger.warn(
        `LIVE_STREAM_SOURCE=fmp but the quote cache is filled by "${this.snapshots.source}" — set LIVE_QUOTE_SOURCE=fmp for FMP prices.`,
      );
    }
  }

  /**
   * GET /live/stream?ticker=AAPL
   *
   * Emits, in order:
   *   event: snapshot  once, with prevClose so the client can compute change
   *   event: status    on every upstream connection-state change
   *   event: tick      per aggregate window (~1/sec while the market is active)
   */
  @Sse("stream")
  stream(@Query("ticker") ticker?: string): Observable<SseEvent> {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym)) {
      throw new BadRequestException(
        'ticker must be 1-10 characters, A-Z and "." only',
      );
    }
    if (this.source === "fmp") return this.streamFromQuoteCache(sym);

    // Upstream subscription is tied to the CLIENT's subscription, not to the
    // request handler. Calling this.live.subscribe() eagerly here would connect
    // upstream before the client is listening, so any status the connection
    // emits synchronously (e.g. "POLYGON_API_KEY not set") would be emitted to
    // nobody and the client would sit on a silent stream with no explanation.
    const upstream$ = new Observable<never>(() => {
      this.live.subscribe(sym);
      return () => this.live.unsubscribe(sym);
    });

    // prevClose is fetched once per stream; the promise is folded into the
    // observable so the snapshot always arrives before any tick is forwarded.
    const snapshot$ = concat(
      of<SseEvent>({
        type: "status",
        data: { connected: false, message: "starting" },
      }),
      new Observable<SseEvent>((sub) => {
        this.live
          .previousClose(sym)
          .then((pc) => {
            sub.next({
              type: "snapshot",
              data: {
                ticker: sym,
                previousClose: pc,
                feed: "polygon-delayed",
                channel: "A",
                delayMinutes: 15,
                note: 'Stocks Starter plan is delayed-only; real-time cluster returns "not authorized".',
              },
            });
            sub.complete();
          })
          .catch(() => sub.complete());
      }),
    );

    // No filter: the service routes by ticker, so this stream only ever
    // carries this client's symbol.
    const ticks$ = this.live.ticksFor(sym).pipe(
      map((t) => ({
        type: "tick",
        data: { ...t },
      })),
    );

    const status$ = this.live.status$.pipe(
      map((s) => ({ type: "status", data: { ...s } })),
    );

    // upstream$ never emits — it exists purely so its teardown runs when the
    // browser disconnects (tab closed, navigation), releasing the ref count.
    // Without it the count would only ever grow.
    return merge(snapshot$, ticks$, status$, upstream$);
  }

  /**
   * fmp-mode stream: re-reads the shared quote cache on an interval and emits
   * a tick only when the quote actually changed. Reads are in-memory — the
   * cache alone decides when the vendor is called — so N clients cost N map
   * lookups per interval, never N vendor requests.
   */
  private streamFromQuoteCache(sym: string): Observable<SseEvent> {
    const quote$ = timer(0, this.pollMs).pipe(
      // exhaustMap: a slow cold-start read is never stacked behind by the next
      // poll; that poll is simply skipped.
      exhaustMap(() =>
        from(this.snapshots.get([sym])).pipe(
          map((r) => r.quotes.find((q) => q.ticker === sym) ?? null),
          // One failed read must not end the stream — the next poll retries.
          catchError(() => of(null)),
        ),
      ),
      filter((q): q is SnapshotQuote => q?.price != null),
      distinctUntilChanged(
        (a, b) =>
          a.price === b.price && a.vendorUpdatedAt === b.vendorUpdatedAt,
      ),
      // Snapshot and ticks share ONE poll loop; subscribed in that order below,
      // so the snapshot always reaches the client before the first tick.
      share(),
    );

    const feed = `${this.snapshots.source}-quote`;
    const snapshot$ = quote$.pipe(
      take(1),
      map((q) => ({
        type: "snapshot",
        data: {
          ticker: sym,
          previousClose: q.previousClose,
          feed,
          channel: "quote",
          delayMinutes: this.snapshots.source === "polygon" ? 15 : 0,
          note: `Quote-cache stream, refreshed every ~${Math.round(this.pollMs / 1000)}s.`,
        },
      })),
    );

    // Per-client, so windowVolume is the day-volume delta since THIS client's
    // previous tick (0 on the first one).
    let lastVolume: number | null = null;
    const ticks$ = quote$.pipe(
      map((q) => {
        const windowVolume =
          q.dayVolume != null && lastVolume != null
            ? Math.max(0, q.dayVolume - lastVolume)
            : 0;
        lastVolume = q.dayVolume;
        const now = Date.now();
        return {
          type: "tick",
          data: {
            ticker: sym,
            price: q.price,
            open: q.open,
            high: q.dayHigh,
            low: q.dayLow,
            windowVolume,
            accumulatedVolume: q.dayVolume,
            vwap: q.dayVwap,
            sessionVwap: q.dayVwap,
            at: q.vendorUpdatedAt ?? now,
            receivedAt: now,
          },
        };
      }),
    );

    return concat(
      of<SseEvent>({
        type: "status",
        data: { connected: true, message: `streaming ${feed}` },
      }),
      merge(snapshot$, ticks$),
    );
  }
}
