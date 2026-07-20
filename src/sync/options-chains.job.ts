import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { OPTIONS_UNIVERSE } from '../common/options-universe';
import { SyncMetaService } from '../common/sync-meta.service';
import { PolygonService } from '../vendors/polygon/polygon.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'options-chains';
const CONTRACTS_PER_TICKER = 20;
const AGG_LOOKBACK_DAYS = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class OptionsChainsJob implements OnModuleInit {
  private readonly logger = new Logger(OptionsChainsJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['options_chains'],
      cronExpression: '0 19 * * 1-5',
      timeZone: 'America/New_York',
    });
  }

  @Cron('0 19 * * 1-5', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    const today = isoDate(new Date());
    const lookback = new Date();
    lookback.setUTCDate(lookback.getUTCDate() - AGG_LOOKBACK_DAYS);
    const from = isoDate(lookback);
    let tickersWritten = 0;
    for (const ticker of OPTIONS_UNIVERSE) {
      try {
        const contracts = await this.polygon.getOptionContracts(ticker, today, CONTRACTS_PER_TICKER);
        await sleep(this.polygon.requestDelayMs);
        const enriched = [];
        for (const c of contracts) {
          try {
            const bar = await this.polygon.getOptionLatestBar(c.ticker, from, today);
            enriched.push({
              contractTicker: c.ticker,
              contractType: c.contract_type,
              strike: c.strike_price,
              expirationDate: c.expiration_date,
              lastClose: bar?.c ?? null,
              lastVolume: bar?.v ?? null,
              lastBarDate: bar ? isoDate(new Date(bar.t)) : null,
            });
          } catch (err) {
            this.logger.warn(`Failed fetching bar for ${c.ticker}: ${err.message}`);
          }
          await sleep(this.polygon.requestDelayMs);
        }
        await this.firebase.firestore
          .collection('options_chains')
          .doc(ticker)
          .set({
            underlyingTicker: ticker,
            contracts: enriched,
            source: 'polygon',
            note: 'Strikes/expirations and last close/volume are real (delayed). Bid/ask, IV, greeks, and open interest are not available on the current Polygon plan.',
            updatedAt: new Date().toISOString(),
          }, { merge: true });
        tickersWritten++;
      } catch (err) {
        this.logger.error(`Failed syncing options for ${ticker}: ${err.message}`);
      }
    }
    await this.meta.record(JOB_NAME, { ok: true, count: tickersWritten });
    return { tickersWritten };
  }
}
