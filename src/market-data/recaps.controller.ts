import { Controller, Get, Header } from "@nestjs/common";
import { RecapsJob } from "../sync/recaps.job";

/**
 * GET /market-data/recaps — backs the Recap screen's numeric fields
 * (indices/gainers/losers/sector leaders-laggards/internals). Live-direct: the
 * CURRENT session's recap is composed fresh per request via the source job, no
 * Firestore cache. A recap is a composition of the other synced collections and
 * their history, so it still reads those upstream collections; only the current
 * recap is reproduced live. `narrative` stays null (no job produces prose yet).
 */
@Controller("market-data")
export class RecapsController {
  constructor(private readonly job: RecapsJob) {}

  @Get("recaps")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async recaps() {
    return this.job.fetchLive();
  }
}
