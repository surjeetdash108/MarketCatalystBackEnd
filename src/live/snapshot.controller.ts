import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { SnapshotService } from "./snapshot.service";
import { MarketStatusService } from "./market-status.service";

/**
 * Cached price snapshot — the scalable alternative to the SSE stream.
 *
 * Every user in a refresh window receives a byte-identical response, which is
 * what lets a CDN serve them all from one origin fetch. The headers below are
 * the whole scaling story:
 *
 *   s-maxage           shared caches (Cloud CDN) may reuse for this long
 *   max-age            browsers may reuse without asking
 *   stale-while-revalidate  serve slightly stale rather than stall on refresh
 *   ETag               unchanged interval -> 304, no body on the wire
 */

const TICKER_RE = /^[A-Z.]{1,10}$/;
const MAX_TICKERS = 50;

@Controller("live")
export class SnapshotController {
  constructor(
    private readonly snapshots: SnapshotService,
    private readonly marketStatus: MarketStatusService,
  ) {}

  /**
   * GET /live/market-status — vendor session state for the header pill.
   *
   * Cached hard at the edge: the answer is identical for every viewer and
   * changes at most a few times a day.
   */
  @Get("market-status")
  @Header(
    "Cache-Control",
    "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
  )
  async status() {
    return this.marketStatus.get();
  }

  /** GET /live/snapshot?tickers=AAPL,MSFT,NVDA */
  @Get("snapshot")
  @Header(
    "Cache-Control",
    "public, max-age=5, s-maxage=10, stale-while-revalidate=30",
  )
  async snapshot(
    @Query("tickers") tickers: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const list = (tickers ?? "")
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);

    if (list.length === 0) throw new BadRequestException("tickers is required");
    if (list.length > MAX_TICKERS) {
      throw new BadRequestException(
        `at most ${MAX_TICKERS} tickers per request`,
      );
    }
    const bad = list.find((t) => !TICKER_RE.test(t));
    if (bad) throw new BadRequestException(`invalid ticker: ${bad}`);

    const { quotes, ageMs } = await this.snapshots.get(list);
    const etag = this.snapshots.etagFor(quotes);

    // 304 costs no body and no serialization — the common case for a client
    // polling faster than the refresh interval.
    if (req.headers["if-none-match"] === etag) {
      res.status(304).setHeader("ETag", etag).end();
      return;
    }

    res.setHeader("ETag", etag);
    res.json({
      quotes,
      cacheAgeMs: ageMs,
      refreshedFrom: "polygon-snapshot",
      delayNote: "Underlying feed is ~15 minutes delayed on the current plan.",
      servedAt: new Date().toISOString(),
    });
  }

  /** Snapshot path is live-direct — no server-side cache to report on. */
  @Get("stats")
  stats() {
    return {
      mode: "live-direct",
      note: "The snapshot path calls the vendor per request; there is no server-side cache.",
    };
  }
}
