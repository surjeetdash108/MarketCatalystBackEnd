import { Logger } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FmpService } from "../vendors/fmp/fmp.service";
import type {
  AdapterResult,
  CanonicalSectorPerformance,
  SectorsAdapter,
} from "./types";
import { withFallback } from "./with-fallback.util";

/** "0.62%" / 0.62 → 0.62. */
function parsePct(v: string | number | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v.replace("%", "").trim());
  return NaN;
}

/**
 * Real cap-weighted sector performance from FMP — an alternative to the Polygon
 * ETF proxy. Off unless SECTORS_SOURCE=fmp (or SECTORS_FALLBACK_SOURCE=fmp).
 * Note: FMP's GICS sector labels may differ from the ETF-proxy labels, so the
 * UI's sector matching should be checked before making FMP the primary.
 */
export class FmpSectorsAdapter implements SectorsAdapter {
  readonly sourceName = "fmp";
  constructor(private readonly fmp: FmpService) {}

  async fetchSectorPerformance(): Promise<
    AdapterResult<CanonicalSectorPerformance[]>
  > {
    const rows = await this.fmp.getSectorPerformance();
    const date = new Date().toISOString().slice(0, 10);
    const data = rows
      .map((r) => ({
        date,
        sector: r.sector,
        exchange: "fmp",
        averageChange: parsePct(r.changesPercentage),
      }))
      .filter((d) => !!d.sector && Number.isFinite(d.averageChange));
    if (data.length === 0)
      throw new Error("FMP returned no sector performance");
    return { data, source: this.sourceName, warnings: [] };
  }
}

export class PolygonSectorsAdapter implements SectorsAdapter {
  readonly sourceName = "polygon";
  constructor(private readonly polygon: PolygonService) {}

  async fetchSectorPerformance(): Promise<
    AdapterResult<CanonicalSectorPerformance[]>
  > {
    const data = await this.polygon.getSectorPerformance();
    // An empty result is a failure, not a valid "no sectors moved" answer —
    // throwing is what lets the composite fall through to the next vendor.
    // This preserves the explicit empty-check the job used to do inline.
    if (data.length === 0) {
      throw new Error("Polygon returned no sector-ETF data");
    }
    return {
      data,
      source: this.sourceName,
      warnings: [
        {
          code: "STALE_DATA",
          field: "averageChange",
          message:
            "Derived from 11 SPDR sector ETFs, not true cap-weighted sector aggregates — Massive has no sector endpoint on any tier.",
        },
      ],
    };
  }
}

export class CompositeSectorsAdapter implements SectorsAdapter {
  private readonly logger = new Logger(CompositeSectorsAdapter.name);
  readonly sourceName: string;

  constructor(
    private readonly primary: SectorsAdapter,
    private readonly secondary: SectorsAdapter | null,
  ) {
    this.sourceName = secondary
      ? `${primary.sourceName}(fallback:${secondary.sourceName})`
      : primary.sourceName;
  }

  fetchSectorPerformance() {
    return withFallback(
      "sector performance",
      this.logger,
      this.primary,
      this.secondary,
      (a) => a.fetchSectorPerformance(),
    );
  }
}
