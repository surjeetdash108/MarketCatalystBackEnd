import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { SyncMetaService } from '../common/sync-meta.service';
import { TICKER_UNIVERSE } from '../common/ticker-universe';
import { PolygonService } from '../vendors/polygon/polygon.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'fundamentals-growth';
const BATCH_SIZE = 60;
const DELAY_MS = 12_500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number, p = 4) => Math.round(n * 10 ** p) / 10 ** p;

@Injectable()
export class FundamentalsGrowthJob implements OnModuleInit {
  private readonly logger = new Logger(FundamentalsGrowthJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['companies'],
      cronExpression: '30 4 * * *',
      timeZone: 'America/New_York',
    });
  }

  @Cron('30 4 * * *', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from({ length: BATCH_SIZE }, (_, i) => TICKER_UNIVERSE[(cursor + i) % TICKER_UNIVERSE.length]);
      const writes = [];
      let skipped = 0;
      for (const ticker of batch) {
        try {
          const periods = await this.polygon.getIncomeStatements(ticker, 'annual', 2);
          const [latest, prior] = periods;
          if (!latest) {
            skipped++;
            await sleep(DELAY_MS);
            continue;
          }
          const revGrowth = prior && prior.revenue != null && prior.revenue > 0 && latest.revenue != null
            ? (latest.revenue - prior.revenue) / prior.revenue
            : null;
          const epsGrowth = prior && prior.dilutedEps != null && prior.dilutedEps > 0 && latest.dilutedEps != null
            ? (latest.dilutedEps - prior.dilutedEps) / prior.dilutedEps
            : null;
          const gp = latest.grossProfit ??
            (latest.revenue != null && latest.costOfRevenue != null
              ? latest.revenue - latest.costOfRevenue
              : null);
          const grossMargin = gp != null && latest.revenue != null && latest.revenue > 0
            ? gp / latest.revenue
            : null;
          writes.push({
            ticker,
            data: {
              revenueGrowthYoY: revGrowth == null ? null : round(revGrowth),
              epsGrowthYoY: epsGrowth == null ? null : round(epsGrowth),
              grossMargin: grossMargin == null ? null : round(grossMargin),
              fundamentalsFiscalYear: latest.fiscalYear,
              fundamentalsUpdatedAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          this.logger.error(`Failed fundamentals for ${ticker}: ${err.message}`);
          skipped++;
        }
        await sleep(DELAY_MS);
      }
      if (writes.length > 0) {
        const wb = this.firebase.firestore.batch();
        const col = this.firebase.firestore.collection('companies');
        for (const w of writes)
          wb.set(col.doc(w.ticker), w.data, { merge: true });
        await wb.commit();
      }
      await this.meta.setCursor(JOB_NAME, (cursor + BATCH_SIZE) % TICKER_UNIVERSE.length);
      await this.meta.record(JOB_NAME, { ok: true, count: writes.length });
      return { updated: writes.length, skipped };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
