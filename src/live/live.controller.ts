import { BadRequestException, Controller, Query, Sse } from '@nestjs/common';
import { Observable, map, merge, of, concat } from 'rxjs';
import { PolygonLiveService } from './polygon-live.service';

/**
 * Server-Sent Events bridge: browser <- our origin <- Polygon delayed WS.
 *
 * SSE rather than a second WebSocket because this stream is strictly one-way
 * (server -> browser). SSE is plain HTTP, reconnects automatically in the
 * browser via EventSource, and needs no extra protocol on either end.
 *
 * The browser sends only a ticker symbol. It never sees the Polygon key.
 */

interface SseEvent {
  data: Record<string, unknown>;
  type: string;
}

/** Symbols only — this value is interpolated into an upstream subscription. */
const TICKER_RE = /^[A-Z.]{1,10}$/;

@Controller('live')
export class LiveController {
  constructor(private readonly live: PolygonLiveService) {}

  /**
   * GET /live/stream?ticker=AAPL
   *
   * Emits, in order:
   *   event: snapshot  once, with prevClose so the client can compute change
   *   event: status    on every upstream connection-state change
   *   event: tick      per aggregate window (~1/sec while the market is active)
   */
  @Sse('stream')
  stream(@Query('ticker') ticker?: string): Observable<SseEvent> {
    const sym = (ticker ?? '').toUpperCase().trim();
    if (!TICKER_RE.test(sym)) {
      throw new BadRequestException(
        'ticker must be 1-10 characters, A-Z and "." only',
      );
    }

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
      of<SseEvent>({ type: 'status', data: { connected: false, message: 'starting' } }),
      new Observable<SseEvent>((sub) => {
        this.live
          .previousClose(sym)
          .then((pc) => {
            sub.next({
              type: 'snapshot',
              data: {
                ticker: sym,
                previousClose: pc,
                feed: 'polygon-delayed',
                channel: 'A',
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
    const ticks$ = this.live
      .ticksFor(sym)
      .pipe(map((t) => ({ type: 'tick', data: { ...t } as Record<string, unknown> })));

    const status$ = this.live.status$.pipe(
      map((s) => ({ type: 'status', data: { ...s } })),
    );

    // upstream$ never emits — it exists purely so its teardown runs when the
    // browser disconnects (tab closed, navigation), releasing the ref count.
    // Without it the count would only ever grow.
    return merge(snapshot$, ticks$, status$, upstream$);
  }
}
