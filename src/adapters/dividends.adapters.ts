import { Logger } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";
import type {
  AdapterResult,
  CanonicalDividendEvent,
  DividendsAdapter,
} from "./types";
import { withFallback } from "./with-fallback.util";

/**
 * Dividend-calendar adapters. Grouped one file per domain rather than one class
 * per file: each vendor implementation is a few lines of delegation, and keeping
 * them beside the composite that chooses between them makes the substitution
 * obvious at a glance.
 */

export class PolygonDividendsAdapter implements DividendsAdapter {
  readonly sourceName = "polygon";
  constructor(private readonly polygon: PolygonService) {}

  async fetchDividends(
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalDividendEvent[]>> {
    const data = await this.polygon.getDividendsCalendar(from, to);
    return {
      data,
      source: this.sourceName,
      // Polygon's dividends payload has no yield field, so yieldPct lands null
      // on every row. Surfaced rather than left for a consumer to discover.
      warnings: data.some((d) => d.yield == null)
        ? [
            {
              code: "FIELD_NOT_SUPPORTED",
              field: "yieldPct",
              message:
                "Polygon does not return dividend yield; yieldPct is null.",
            },
          ]
        : [],
    };
  }
}

export class CompositeDividendsAdapter implements DividendsAdapter {
  private readonly logger = new Logger(CompositeDividendsAdapter.name);
  readonly sourceName: string;

  constructor(
    private readonly primary: DividendsAdapter,
    private readonly secondary: DividendsAdapter | null,
  ) {
    this.sourceName = secondary
      ? `${primary.sourceName}(fallback:${secondary.sourceName})`
      : primary.sourceName;
  }

  fetchDividends(from: string, to: string) {
    return withFallback(
      "dividends",
      this.logger,
      this.primary,
      this.secondary,
      (a) => a.fetchDividends(from, to),
    );
  }
}
