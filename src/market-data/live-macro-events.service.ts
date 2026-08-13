import { Injectable } from "@nestjs/common";
import { MACRO_SERIES } from "../common/macro-series";
import { FredService } from "../vendors/fred/fred.service";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the `macro-events` sync job + Firestore cache. Fetches
 * the latest two observations of each FRED macro series on demand and maps them
 * to the `MacroEventDoc` shape the Macro & VIX economic calendar reads. Series
 * are fetched in parallel (13 independent FRED calls) and coalesced for a few
 * seconds. Preserves the mapping from the deleted `sync/macro-events.job.ts`.
 */
@Injectable()
export class LiveMacroEventsService {
  private readonly coalescer = new LiveCoalescer(5_000);

  constructor(private readonly fred: FredService) {}

  async getMacroEvents() {
    return this.coalescer.run("macro-events", async () => {
      const rows = await Promise.all(
        MACRO_SERIES.map(async (series) => {
          try {
            const obs = await this.fred.getLatestObservations(series.seriesId, 2);
            const [latest, prior] = obs;
            if (!latest) return null;
            const actual = latest.value === "." ? null : Number(latest.value);
            const previous =
              prior && prior.value !== "." ? Number(prior.value) : null;
            return {
              name: series.name,
              seriesId: series.seriesId,
              country: series.country,
              unit: series.unit,
              importance: series.importance,
              eventDate: latest.date,
              actual,
              previous,
              estimate: null,
              source: "fred",
            };
          } catch {
            return null;
          }
        }),
      );
      return rows.filter((r): r is NonNullable<typeof r> => r !== null);
    });
  }
}
