import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { setWithCreatedAt } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { TICKER_UNIVERSE } from '../common/ticker-universe';
import { FmpService } from '../vendors/fmp/fmp.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'analyst-actions';
const BATCH_SIZE = 60;
const DELAY_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class AnalystActionsJob implements OnModuleInit {
  private readonly logger = new Logger(AnalystActionsJob.name);

  constructor(
    private readonly fmp: FmpService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['analyst_actions'],
      cronExpression: '0 6 * * *',
      timeZone: 'America/New_York',
    });
  }

  @Cron('0 6 * * *', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from({ length: BATCH_SIZE }, (_, i) => TICKER_UNIVERSE[(cursor + i) % TICKER_UNIVERSE.length]);
      let written = 0;
      const col = this.firebase.firestore.collection('analyst_actions');
      for (const symbol of batch) {
        try {
          const consensus = await this.fmp.getGradesConsensus(symbol);
          if (!consensus)
            continue;
          await setWithCreatedAt(this.firebase.firestore, col.doc(symbol), {
            ticker: symbol,
            source: 'fmp_consensus_interim',
            strongBuy: consensus.strongBuy,
            buy: consensus.buy,
            hold: consensus.hold,
            sell: consensus.sell,
            strongSell: consensus.strongSell,
            consensus: consensus.consensus,
            updatedAt: new Date().toISOString(),
          });
          written++;
        } catch (err) {
          this.logger.error(`Failed syncing analyst grades for ${symbol}: ${err.message}`);
        }
        await sleep(DELAY_MS);
      }
      await this.meta.setCursor(JOB_NAME, (cursor + BATCH_SIZE) % TICKER_UNIVERSE.length);
      await this.meta.record(JOB_NAME, { ok: true, count: written });
      return { written };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
