import { Injectable, Logger } from "@nestjs/common";
import { MACRO_SERIES } from "../common/macro-series";
import { FredService } from "../vendors/fred/fred.service";

@Injectable()
export class MacroEventsJob {
  private readonly logger = new Logger(MacroEventsJob.name);

  constructor(private readonly fred: FredService) {}

  /**
   * Live-direct: fetch + shape the FRED macro-event rows WITHOUT writing
   * Firestore, returning the exact `{id, ...data}` shape the `macro_events`
   * collection read used to yield. Backs GET /market-data/macro-events.
   */
  async fetchLive(): Promise<Record<string, unknown>[]> {
    const docs = await this.buildDocs();
    return docs.map((d) => ({ id: d.id, ...d.data }));
  }

  private async buildDocs(): Promise<
    { id: string; data: Record<string, unknown> }[]
  > {
    const docs: { id: string; data: Record<string, unknown> }[] = [];
    for (const series of MACRO_SERIES) {
      try {
        const obs = await this.fred.getLatestObservations(series.seriesId, 2);
        const [latest, prior] = obs;
        if (!latest) {
          this.logger.warn(
            `No observations returned for ${series.name} (${series.seriesId})`,
          );
          continue;
        }
        const actual = latest.value === "." ? null : Number(latest.value);
        const previous =
          prior && prior.value !== "." ? Number(prior.value) : null;
        docs.push({
          id: series.seriesId,
          data: {
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
            updatedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        this.logger.error(
          `Failed syncing ${series.name} (${series.seriesId}): ${err.message}`,
        );
      }
    }
    return docs;
  }
}
