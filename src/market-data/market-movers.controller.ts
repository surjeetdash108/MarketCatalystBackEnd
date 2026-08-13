import { Controller, Get, Header, Inject, Logger } from '@nestjs/common';
import { AllSourcesFailedError } from '../adapters/adapter-error';
import { MOVERS_ADAPTER, MOVER_ENRICHMENT_ADAPTER, type CanonicalMoverBase, type MoverEnrichmentAdapter, type MoversAdapter } from '../adapters/types';

const TOP_N = 20;
const DELAY_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET /market-data/movers — backs the Movers screen and the Dashboard/shell
 * "Movers" widgets. Calls Polygon directly on every request (no Firestore
 * cache, no sync job) so the board always reflects live data — mirrors the
 * fetch + enrich logic in market-movers.job.ts, minus the persistence step.
 */
@Controller('market-data')
export class MarketMoversController {
  private readonly logger = new Logger(MarketMoversController.name);

  constructor(
    @Inject(MOVERS_ADAPTER) private readonly moversAdapter: MoversAdapter,
    @Inject(MOVER_ENRICHMENT_ADAPTER) private readonly enrichment: MoverEnrichmentAdapter,
  ) {}

  @Get('movers')
  @Header('Cache-Control', 'no-store')
  async movers() {
    const moversResult = await this.moversAdapter.fetchTopMovers(TOP_N);
    const { date, gainers, losers } = moversResult.data;
    const topMovers = [...gainers, ...losers];
    if (moversResult.warnings.length > 0) {
      this.logger.warn(`market-movers: ${moversResult.warnings.map((w) => w.message).join(' | ')}`);
    }

    const enrichmentByTicker = new Map();
    for (const m of topMovers) {
      try {
        const enriched = await this.enrichment.enrichTicker(m.ticker);
        if (enriched) {
          enrichmentByTicker.set(m.ticker, {
            value: enriched.data,
            warnings: enriched.warnings,
          });
        } else {
          enrichmentByTicker.set(m.ticker, {
            value: null,
            warnings: [
              {
                code: 'SUB_REQUEST_FAILED',
                field: 'name,sector,cap',
                message: `${this.enrichment.sourceName} found no profile for ${m.ticker}.`,
              },
            ],
          });
        }
      } catch (err) {
        if (err instanceof AllSourcesFailedError) {
          this.logger.warn(`Enrichment failed for mover ${m.ticker}: every source failed — ${err.attempts.map((a) => `${a.source}: ${a.error}`).join(' | ')}`);
          enrichmentByTicker.set(m.ticker, {
            value: null,
            warnings: [
              {
                code: 'SUB_REQUEST_FAILED',
                field: 'name,sector,cap',
                message: err.message,
              },
            ],
          });
        } else {
          throw err;
        }
      }
      await sleep(DELAY_MS);
    }

    const toDoc = (m: CanonicalMoverBase, direction: 'gainer' | 'loser') => {
      const enriched = enrichmentByTicker.get(m.ticker);
      const warnings = [
        ...moversResult.warnings,
        ...(enriched?.warnings ?? []),
      ];
      return {
        id: `${direction}_${m.ticker}`,
        ...m,
        ...enriched?.value,
        direction,
        source: this.moversAdapter.sourceName,
        warnings,
        updatedAt: new Date().toISOString(),
        asOfDate: date,
      };
    };

    return [
      ...gainers.map((g) => toDoc(g, 'gainer')),
      ...losers.map((l) => toDoc(l, 'loser')),
    ];
  }
}
