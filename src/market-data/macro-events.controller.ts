import { Controller, Get, Header, Logger } from '@nestjs/common';
import { MACRO_SERIES } from '../common/macro-series';
import { FredService } from '../vendors/fred/fred.service';

/**
 * GET /market-data/macro-events — backs the Macro & VIX screen's live
 * economic calendar. Calls FRED directly on every request (no Firestore
 * cache, no sync job) — mirrors macro-events.job.ts's per-series fetch,
 * minus persistence. A single series failing (e.g. a bad/missing FRED API
 * key) is skipped rather than failing the whole request, same as the job.
 */
@Controller('market-data')
export class MacroEventsController {
  private readonly logger = new Logger(MacroEventsController.name);

  constructor(private readonly fred: FredService) {}

  @Get('macro-events')
  @Header('Cache-Control', 'no-store')
  async macroEvents() {
    const docs: Record<string, unknown>[] = [];
    for (const series of MACRO_SERIES) {
      try {
        const obs = await this.fred.getLatestObservations(series.seriesId, 2);
        const [latest, prior] = obs;
        if (!latest) {
          this.logger.warn(`No observations returned for ${series.name} (${series.seriesId})`);
          continue;
        }
        const actual = latest.value === '.' ? null : Number(latest.value);
        const previous = prior && prior.value !== '.' ? Number(prior.value) : null;
        docs.push({
          id: series.seriesId,
          name: series.name,
          seriesId: series.seriesId,
          country: series.country,
          unit: series.unit,
          importance: series.importance,
          eventDate: latest.date,
          actual,
          previous,
          estimate: null,
          source: 'fred',
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        this.logger.error(`Failed fetching ${series.name} (${series.seriesId}): ${(err as Error).message}`);
      }
    }
    return docs;
  }
}
