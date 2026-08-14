import { Controller, Get, Header, Req, Res, Sse } from "@nestjs/common";
import type { Request, Response } from "express";
import { Observable, interval, map, merge } from "rxjs";
import { TapeService, type TapeFrame } from "./tape.service";

/**
 * Header ticker tape, streamed from our origin.
 *
 * SSE rather than a WebSocket because the stream is strictly one-way
 * (server -> browser), it is plain HTTP so it needs no protocol upgrade through
 * Cloud Run, and EventSource reconnects on its own with no client-side retry
 * code. Same reasoning as live.controller.ts.
 *
 * Every connected browser subscribes to the SAME observable inside TapeService.
 * Nothing in this file talks to the vendor, and nothing here varies per client
 * — that is what makes upstream load independent of user count.
 */

interface SseEvent {
  data: Record<string, unknown>;
  type: string;
}

/**
 * Idle-connection keepalive. When the market is closed the tape does not
 * change, so TapeService suppresses frames entirely and a connection can sit
 * silent for 15 minutes — long enough for Cloud Run, a corporate proxy or a
 * phone's radio to reap it as dead. A tiny event on a fixed cadence keeps the
 * path warm and lets the client detect a genuine stall.
 *
 * A `:comment` line is the conventional SSE keepalive, but Nest's @Sse
 * serializer only emits `event:`/`data:` frames. A named event costs ~50 bytes
 * more and has the advantage that the browser can listen for it.
 */
const HEARTBEAT_MS = 20_000;

@Controller("live")
export class TapeController {
  constructor(private readonly tape: TapeService) {}

  /**
   * GET /live/tape/stream — the live tape.
   *
   * Emits:
   *   event: tape       full frame; the first arrives immediately from the
   *                     ReplaySubject's buffer, then one per actual change
   *   event: heartbeat  every 20s, so a silent market is distinguishable from
   *                     a dead connection
   */
  @Sse("tape/stream")
  stream(): Observable<SseEvent> {
    // Ref counting is tied to the CLIENT's subscription, not to this handler
    // running: the teardown below is what fires when the browser disconnects
    // (tab closed, navigation, network drop). Calling addClient() directly in
    // the handler body would leak a reference on every request, and the poller
    // would never stop. Same trick as live.controller.ts's `upstream$`.
    const lifecycle$ = new Observable<never>(() => {
      this.tape.addClient();
      return () => this.tape.removeClient();
    });

    const frames$ = this.tape.frames$.pipe(
      map((f) => ({
        type: "tape",
        data: f as unknown as Record<string, unknown>,
      })),
    );

    const heartbeat$ = interval(HEARTBEAT_MS).pipe(
      map(() => ({
        type: "heartbeat",
        data: {
          at: new Date().toISOString(),
          stale: this.tape.lastKnownFrame?.stale ?? true,
        },
      })),
    );

    return merge(frames$, heartbeat$, lifecycle$);
  }

  /**
   * GET /live/tape — the same frame as plain JSON.
   *
   * Exists for callers that cannot hold a connection (curl, a server-rendered
   * page, a health probe) and as the fallback if EventSource is unavailable.
   * Cached at the edge and ETagged, so a burst of these still collapses to one
   * upstream call — TapeService.currentFrame() refuses to refetch inside a
   * refresh window.
   */
  @Get("tape")
  @Header(
    "Cache-Control",
    "public, max-age=30, s-maxage=60, stale-while-revalidate=120",
  )
  async current(@Req() req: Request, @Res() res: Response) {
    const frame: TapeFrame = await this.tape.currentFrame();
    const etag = this.tape.etagFor(frame);

    if (req.headers["if-none-match"] === etag) {
      res.status(304).setHeader("ETag", etag).end();
      return;
    }
    res.setHeader("ETag", etag);
    res.json(frame);
  }

  /**
   * GET /live/tape/stats — the scaling assertion, made checkable.
   *
   * `upstreamCalls` must stay flat as `clients` grows. If the two ever track
   * each other, the broadcast has broken and every viewer is costing a vendor
   * request.
   */
  @Get("tape/stats")
  stats() {
    return {
      ...this.tape.stats,
      note: "upstreamCalls should stay flat (~1/min) no matter how large clients gets.",
    };
  }
}
