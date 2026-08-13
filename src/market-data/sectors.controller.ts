import { Controller, Get } from "@nestjs/common";
import { LiveSectorsService } from "./live-sectors.service";

/**
 * GET /market-data/sectors — backs the Market Heatmap screen's per-sector
 * `pctChange` (the `SectorApiDoc` shape). Now fetched LIVE from the vendor per
 * request (via LiveSectorsService) — no Firestore cache, no sync job. Concurrent
 * requests are coalesced for a few seconds inside the service.
 *
 * No Cache-Control header: the point of the refactor is fresh-per-request data,
 * so we don't let a CDN/browser hold a stale copy.
 */
@Controller("market-data")
export class SectorsController {
  constructor(private readonly liveSectors: LiveSectorsService) {}

  @Get("sectors")
  async sectors() {
    return this.liveSectors.getSectors();
  }
}
