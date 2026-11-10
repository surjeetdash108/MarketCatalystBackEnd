import { Controller, Get, Header, Query, UseGuards } from "@nestjs/common";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { NewsWireService } from "./news-wire.service";
import { EarningsWireService } from "./earnings-wire.service";

/**
 * GET /live/news-wire?since=<ISO> — the live news tape (FMP latest stock news,
 * re-polled every 15s server-side). The Intraday commentary tab polls this and
 * prepends whatever is newer than the newest story it already shows.
 *
 * GET /live/earnings-wire — results companies have declared (today + yesterday,
 * ET) as news-shaped rows, merged into the same tape by the UI.
 */
@Controller("live")
@UseGuards(FirebaseAuthGuard)
export class NewsWireController {
  constructor(
    private readonly wire: NewsWireService,
    private readonly earnings: EarningsWireService,
  ) {}

  @Get("news-wire")
  @Header("Cache-Control", "private, max-age=5")
  latest(@Query("since") since?: string) {
    return this.wire.latest(since);
  }

  @Get("earnings-wire")
  @Header("Cache-Control", "private, max-age=30")
  earningsResults() {
    return this.earnings.latest();
  }
}
