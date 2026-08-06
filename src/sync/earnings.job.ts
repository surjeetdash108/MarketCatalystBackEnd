import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { chunkedBatchSet } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { PolygonService } from '../vendors/polygon/polygon.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'earnings';
// Past-only window. Polygon is the sole source: it has no earnings-calendar or
// estimate feed, so the calendar is built from reported SEC financials keyed on
// `filing_date`. There is therefore no lookahead — only already-filed quarters.
const LOOKBACK_DAYS = 180;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

@Injectable()
export class EarningsJob implements OnModuleInit {
  private readonly logger = new Logger(EarningsJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['earnings_events'],
      cronExpression: '0 6 * * *',
      timeZone: 'America/New_York',
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const to = isoDate(new Date());
      const from = isoDate(addDays(new Date(), -LOOKBACK_DAYS));
      const rows = await this.polygon.getFinancialsByFilingDate(from, to);
      const docs = rows
        .filter((r) => r.filingDate)
        .map((r) => ({
          id: `${r.ticker}_${r.filingDate}`,
          data: {
            ticker: r.ticker,
            companyName: r.companyName,
            // Reporting date = SEC filing date (Polygon has no announcement feed).
            date: r.filingDate,
            periodEnd: r.periodEnd,
            fiscalPeriod: r.fiscalPeriod,
            fiscalYear: r.fiscalYear,
            // No session / estimate feed from Polygon — actuals only.
            session: null,
            epsEstimate: null,
            epsActual: r.epsActual,
            revenueEstimate: null,
            revenueActual: r.revenueActual,
            updatedAt: new Date().toISOString(),
          },
        }));
      await chunkedBatchSet(this.firebase.firestore, 'earnings_events', docs);
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      this.logger.log(`earnings: wrote ${docs.length} reported quarters (${from}..${to})`);
      return { count: docs.length };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
