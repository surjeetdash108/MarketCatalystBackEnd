import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import WebSocket from 'ws';
import { PolygonService } from '../vendors/polygon/polygon.service';

/**
 * One upstream Polygon WebSocket, fanned out to many browser clients.
 *
 * WHY THIS LIVES ON THE SERVER
 * The browser never talks to Polygon. If it did, the API key would ship in
 * client-side JavaScript where anyone can read it — there is no way to hide a
 * key in a browser. The key stays here; the browser gets a plain SSE stream
 * from our own origin.
 *
 * WHICH FEED (verified against the live endpoint 2026-07-20)
 * The Stocks Starter plan is DELAYED-ONLY:
 *   wss://socket.polygon.io/stocks   -> "You don't have access real-time data"
 *   wss://delayed.polygon.io/stocks  -> connects; A + AM channels authorized,
 *                                       T (trades) and Q (quotes) rejected
 * So this subscribes to `A` (per-second aggregates). Every price it emits is
 * ~15 MINUTES OLD. That is a plan limitation, not a bug — the UI must label it.
 *
 * SCALE-TO-ZERO WARNING
 * A WebSocket needs a process that stays connected. The production deployment
 * is Cloud Run with scale-to-zero and no warm instance between cron firings, so
 * this module only does useful work when something keeps the container alive
 * (min-instances >= 1). It is intended for local evaluation as it stands.
 */

const DELAYED_WS_URL = 'wss://delayed.polygon.io/stocks';
/** Upstream reconnect backoff, capped so a long outage doesn't spin hot. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * Liveness. The `ws` client does not ping on its own, and a network path can
 * die WITHOUT a FIN (NAT idle timeout, VPN drop, cloud partition). When that
 * happens `close` never fires, readyState stays OPEN, and ensureConnected()
 * early-returns forever — the stream is dead but the object believes it is
 * healthy. Pinging turns that silent death into a detectable stall.
 */
const HEARTBEAT_MS = 20_000;
/** No inbound bytes (tick, pong or status) for this long -> assume half-open. */
const STALL_TIMEOUT_MS = 45_000;

/** A per-second aggregate as Polygon sends it on the `A` channel. */
interface PolygonAggMessage {
  ev: 'A' | 'AM';
  sym: string;
  /** Tick volume for this window. */
  v: number;
  /** Accumulated volume for the session. */
  av?: number;
  /** Volume-weighted average price for this window. */
  vw: number;
  /** Session VWAP. */
  a?: number;
  o: number;
  c: number;
  h: number;
  l: number;
  /** Window start, epoch ms. */
  s: number;
  e?: number;
}

export interface LiveTick {
  ticker: string;
  price: number;
  open: number;
  high: number;
  low: number;
  windowVolume: number;
  accumulatedVolume: number | null;
  vwap: number;
  sessionVwap: number | null;
  /** Window start, epoch ms — the time the DELAYED data refers to. */
  at: number;
  /** When we received it — the gap versus `at` is the vendor delay. */
  receivedAt: number;
}

@Injectable()
export class PolygonLiveService implements OnModuleDestroy {
  private readonly logger = new Logger(PolygonLiveService.name);
  private readonly apiKey: string;

  private ws: WebSocket | null = null;
  private authed = false;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Last time ANY inbound frame arrived — the stall detector's input. */
  private lastInboundAt = 0;
  /**
   * Set when the vendor rejects us in a way retrying cannot fix (bad or
   * rotated key). Without this, auth_failed loops forever at the backoff cap,
   * which looks identical to a transient outage in the logs.
   */
  private fatal: string | null = null;
  private closing = false;

  /** ticker -> number of browser clients watching it (ref count). */
  private readonly refCounts = new Map<string, number>();

  /**
   * Per-ticker streams. Previously this was a single Subject that every client
   * filtered, which is O(clients x ticks): 20 ticks/sec against 10k subscribers
   * is 200k predicate evaluations per second to deliver ~10k useful messages.
   * Keying by ticker makes delivery proportional to interested clients only.
   */
  private readonly tickSubjects = new Map<string, Subject<LiveTick>>();
  /** Connection-state changes, so the UI can show an honest status. */
  readonly status$ = new Subject<{ connected: boolean; message: string }>();

  constructor(
    private readonly config: ConfigService,
    private readonly polygon: PolygonService,
  ) {
    this.apiKey = this.config.get('POLYGON_API_KEY', '');
  }

  /** Stream for one ticker, created on first use. */
  ticksFor(ticker: string): Subject<LiveTick> {
    const sym = ticker.toUpperCase();
    let s = this.tickSubjects.get(sym);
    if (!s) {
      s = new Subject<LiveTick>();
      this.tickSubjects.set(sym, s);
    }
    return s;
  }

  onModuleDestroy() {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.ws?.close();
  }

  /**
   * Previous close, so the client can render change/%-change on the very first
   * tick instead of showing "—" until the next session boundary.
   */
  async previousClose(ticker: string): Promise<number | null> {
    try {
      const q = await this.polygon.getDailyQuote(ticker);
      return q?.pc ?? null;
    } catch (err) {
      this.logger.warn(`prevClose lookup failed for ${ticker}: ${err.message}`);
      return null;
    }
  }

  /** Registers interest in a ticker, connecting/subscribing upstream if needed. */
  subscribe(ticker: string): void {
    const sym = ticker.toUpperCase();
    const next = (this.refCounts.get(sym) ?? 0) + 1;
    this.refCounts.set(sym, next);
    if (next === 1) {
      this.ensureConnected();
      this.sendSubscribe(sym);
    }
  }

  /** Releases interest; unsubscribes upstream when the last client leaves. */
  unsubscribe(ticker: string): void {
    const sym = ticker.toUpperCase();
    const next = (this.refCounts.get(sym) ?? 1) - 1;
    if (next <= 0) {
      this.refCounts.delete(sym);
      this.tickSubjects.get(sym)?.complete();
      this.tickSubjects.delete(sym);
      if (this.authed && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ action: 'unsubscribe', params: `A.${sym}` }));
      }
    } else {
      this.refCounts.set(sym, next);
    }
  }

  private sendSubscribe(sym: string) {
    if (this.authed && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'subscribe', params: `A.${sym}` }));
    }
    // If not yet authed, onAuthSuccess replays every ref-counted ticker.
  }

  /** Returns true if a socket exists (or was just created) afterwards. */
  private ensureConnected(): boolean {
    if (this.ws || this.closing) return true;
    if (!this.apiKey) {
      this.status$.next({ connected: false, message: 'POLYGON_API_KEY not set' });
      return false;
    }
    if (this.fatal) {
      this.status$.next({ connected: false, message: `not retrying: ${this.fatal}` });
      return false;
    }

    this.logger.log(`connecting to ${DELAYED_WS_URL}`);
    const ws = new WebSocket(DELAYED_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.lastInboundAt = Date.now();
      this.startHeartbeat(ws);
      ws.send(JSON.stringify({ action: 'auth', params: this.apiKey }));
    });

    // A pong is proof the far end is still reachable even when the market is
    // quiet and no ticks are flowing.
    ws.on('pong', () => { this.lastInboundAt = Date.now(); });

    ws.on('message', (raw: WebSocket.RawData) => {
      this.lastInboundAt = Date.now();
      let msgs: any[];
      try {
        msgs = JSON.parse(raw.toString());
      } catch {
        return;
      }
      for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
        this.handleMessage(m);
      }
    });

    ws.on('error', (err) => {
      this.logger.error(`upstream socket error: ${err.message}`);
      this.status$.next({ connected: false, message: err.message });
    });

    ws.on('close', (code, reason) => {
      this.authed = false;
      this.ws = null;
      this.stopHeartbeat();
      // Close code and reason were previously discarded, which is why the
      // one-socket-per-key thrash took an experiment to diagnose instead of
      // being readable in the log.
      const why = `code ${code}${reason?.length ? ` (${reason.toString()})` : ''}`;
      this.logger.log(`upstream closed: ${why}`);
      this.status$.next({ connected: false, message: `upstream closed: ${why}` });
      if (!this.closing && !this.fatal && this.refCounts.size > 0) {
        this.scheduleReconnect();
      }
    });
    return true;
  }

  /** Pings on an interval and forcibly kills a socket that has gone quiet. */
  private startHeartbeat(ws: WebSocket) {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const idle = Date.now() - this.lastInboundAt;
      if (idle > STALL_TIMEOUT_MS) {
        this.logger.warn(`no inbound data for ${Math.round(idle / 1000)}s — terminating half-open socket`);
        // terminate(), not close(): a half-open socket will never complete the
        // closing handshake, so close() would hang. terminate() destroys it
        // immediately and fires 'close', re-entering the reconnect path.
        ws.terminate();
        return;
      }
      ws.ping();
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private handleMessage(m: any) {
    if (m.ev === 'status') {
      if (m.status === 'auth_success') {
        this.authed = true;
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.status$.next({ connected: true, message: 'authenticated (delayed feed)' });
        // Replay subscriptions — covers both first connect and reconnect.
        for (const sym of this.refCounts.keys()) {
          this.ws?.send(JSON.stringify({ action: 'subscribe', params: `A.${sym}` }));
        }
      } else if (m.status === 'auth_failed') {
        // Terminal: a rejected key is not a transient outage. Retrying would
        // spin at the 30s backoff cap indefinitely while looking like a
        // network problem. Fail loudly and stop.
        this.fatal = m.message ?? 'auth_failed';
        this.logger.error(`AUTH FAILED — not retrying until restart: ${this.fatal}`);
        this.status$.next({ connected: false, message: `auth failed: ${this.fatal}` });
        this.ws?.close();
      } else if (m.status === 'error') {
        this.logger.error(`upstream status error: ${m.message}`);
        this.status$.next({ connected: false, message: m.message ?? 'error' });
      }
      return;
    }

    if (m.ev === 'A' || m.ev === 'AM') {
      const a = m as PolygonAggMessage;
      const subject = this.tickSubjects.get(a.sym);
      if (!subject) return; // nobody is watching this symbol
      subject.next({
        ticker: a.sym,
        price: a.c,
        open: a.o,
        high: a.h,
        low: a.l,
        windowVolume: a.v,
        accumulatedVolume: a.av ?? null,
        vwap: a.vw,
        sessionVwap: a.a ?? null,
        at: a.s,
        receivedAt: Date.now(),
      });
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.logger.log(`reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Exponential backoff, capped — a long vendor outage must not spin hot.
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      // If ensureConnected() early-returns without a socket, the wakeup would
      // otherwise be lost: the timer is already nulled and nothing reschedules.
      const ok = this.ensureConnected();
      if (!ok && !this.fatal && !this.closing && this.refCounts.size > 0) {
        this.scheduleReconnect();
      }
    }, delay);
  }
}
