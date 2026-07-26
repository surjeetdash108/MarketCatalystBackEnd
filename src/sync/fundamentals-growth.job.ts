import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { batchSetWithCreatedAt, type PendingWrite } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { activeUniverse } from '../common/ticker-universe';
import { FINANCIALS_ADAPTER, type FinancialsAdapter } from '../adapters/types';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'fundamentals-growth';
const BATCH_SIZE = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number, p = 4) => Math.round(n * 10 ** p) / 10 ** p;

@Injectable()
export class FundamentalsGrowthJob implements OnModuleInit {
  private readonly logger = new Logger(FundamentalsGrowthJob.name);

  constructor(
    @Inject(FINANCIALS_ADAPTER) private readonly financials: FinancialsAdapter,
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

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const universe = await activeUniverse(this.firebase.firestore);
      if (universe.length === 0) {
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { count: 0, note: 'no active tickers yet' };
      }
      // Batch never larger than the active universe, so a small
      // universe is fully covered in one premarket run.
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from({ length: Math.min(BATCH_SIZE, universe.length) }, (_, i) => universe[(cursor + i) % universe.length]);
      const writes = [];
      let skipped = 0;
      for (const ticker of batch) {
        try {
          const result = await this.financials.fetchIncomeStatements(ticker, 'annual', 2);
          const periods = result.data;
          const [latest, prior] = periods;
          if (!latest) {
            skipped++;
            await sleep(this.financials.requestDelayMs);
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
        await sleep(this.financials.requestDelayMs);
      }
      if (writes.length > 0) {
        const pendingWrites: PendingWrite[] = [];
        const col = this.firebase.firestore.collection('companies');
        for (const w of writes)
          pendingWrites.push({ ref: col.doc(w.ticker), data: w.data });
        await batchSetWithCreatedAt(this.firebase.firestore, pendingWrites);
      }
      await this.meta.setCursor(JOB_NAME, (cursor + BATCH_SIZE) % universe.length);
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
