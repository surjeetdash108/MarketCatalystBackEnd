import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AllSourcesFailedError } from '../adapters/adapter-error';
import { MOVERS_ADAPTER, MOVER_ENRICHMENT_ADAPTER, type MoverEnrichmentAdapter, type MoversAdapter } from '../adapters/types';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { SyncMetaService } from '../common/sync-meta.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'market-movers';
const TOP_N = 20;
const DELAY_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class MarketMoversJob implements OnModuleInit {
  private readonly logger = new Logger(MarketMoversJob.name);

  constructor(
    @Inject(MOVERS_ADAPTER) private readonly movers: MoversAdapter,
    @Inject(MOVER_ENRICHMENT_ADAPTER) private readonly enrichment: MoverEnrichmentAdapter,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['market_movers', 'market_movers_history'],
      cronExpression: '0 18 * * 1-5',
      timeZone: 'America/New_York',
    });
  }

  @Cron('0 18 * * 1-5', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const moversResult = await this.movers.fetchTopMovers(TOP_N);
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
      const batch = this.firebase.firestore.batch();
      const col = this.firebase.firestore.collection('market_movers');
      const historyCol = this.firebase.firestore.collection('market_movers_history');
      let enrichmentFailures = 0;
      const writeMover = (m, direction) => {
        const enriched = enrichmentByTicker.get(m.ticker);
        const warnings = [
          ...moversResult.warnings,
          ...(enriched?.warnings ?? []),
        ];
        if (enriched?.value == null)
          enrichmentFailures++;
        const doc = {
          ...m,
          ...enriched?.value,
          direction,
          source: this.movers.sourceName,
          warnings,
          updatedAt: new Date().toISOString(),
        };
        batch.set(col.doc(`${direction}_${m.ticker}`), doc);
        batch.set(historyCol.doc(`${date}_${direction}_${m.ticker}`), doc);
      };
      gainers.forEach((g) => writeMover(g, 'gainer'));
      losers.forEach((l) => writeMover(l, 'loser'));
      await batch.commit();
      await this.meta.record(JOB_NAME, {
        ok: true,
        count: gainers.length + losers.length,
        ...(enrichmentFailures > 0
          ? {
            error: `${enrichmentFailures}/${topMovers.length} movers missing name/sector/cap enrichment`,
          }
          : {}),
      });
      return {
        gainers: gainers.length,
        losers: losers.length,
        asOfDate: date,
        enrichmentFailures,
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
