import { Controller, Get } from "@nestjs/common";
import { LiveIposService } from "./live-ipos.service";

/**
 * GET /market-data/ipos — IPO Corner recent-performance + calendar. Served LIVE
 * per request (Polygon IPO calendar + per-listed-name aftermarket bars). No
 * cache, no job.
 */
@Controller("market-data")
export class IposController {
  constructor(private readonly liveIpos: LiveIposService) {}

  @Get("ipos")
  async ipos() {
    return this.liveIpos.getIpos();
  }
}
