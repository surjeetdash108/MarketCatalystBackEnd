import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { chunkedBatchSet } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { FinnhubService } from '../vendors/finnhub/finnhub.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'earnings';
// Finnhub's earnings calendar keys rows on the ANNOUNCEMENT date and carries
// EPS/revenue estimates + actuals + the BMO/AMC session. That fixes the empty
// recent/upcoming dates the old Polygon filing-date source left behind (Polygon
// has no estimates and no forward calendar — a company only appeared once it had
// filed its 10-Q, days/weeks after it reported). The window spans recent history
// plus the next several weeks so the hub shows just-reported AND upcoming names.
const LOOKBACK_DAYS = 120;
const LOOKAHEAD_DAYS = 45;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** Finnhub `hour`: bmo = before market open, amc = after market close, dmh/'' = during/none. */
function sessionFromHour(hour: string | null | undefined): string | null {
  const h = (hour ?? '').toLowerCase();
  if (h === 'bmo') return 'BMO';
  if (h === 'amc') return 'AMC';
  return null;
}

@Injectable()
export class EarningsJob implements OnModuleInit {
  private readonly logger = new Logger(EarningsJob.name);

  constructor(
    private readonly finnhub: FinnhubService,
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
      const from = isoDate(addDays(new Date(), -LOOKBACK_DAYS));
      const to = isoDate(addDays(new Date(), LOOKAHEAD_DAYS));
      const rows = await this.finnhub.getEarningsCalendar(from, to);

      const docs = rows
        .filter((r) => r.symbol && r.date)
        .map((r) => ({
          id: `${r.symbol}_${r.date}`,
          data: {
            ticker: r.symbol,
            companyName: null,
            // Reporting date = earnings announcement date (Finnhub).
            date: r.date,
            periodEnd: null,
            fiscalPeriod: r.quarter ? `Q${r.quarter}` : null,
            fiscalYear: r.year ? String(r.year) : null,
            session: sessionFromHour(r.hour),
            epsEstimate: r.epsEstimate,
            epsActual: r.epsActual,
            revenueEstimate: r.revenueEstimate,
            revenueActual: r.revenueActual,
            updatedAt: new Date().toISOString(),
          },
        }));

      await chunkedBatchSet(this.firebase.firestore, 'earnings_events', docs);

      // Full refresh: the calendar is the sole source, so the collection must
      // hold exactly this run's rows. Delete any doc not in the new set.
      const keep = new Set(docs.map((d) => d.id));
      const col = this.firebase.firestore.collection('earnings_events');
      const stale = (await col.listDocuments()).filter((ref) => !keep.has(ref.id));
      for (let i = 0; i < stale.length; i += 400) {
        const batch = this.firebase.firestore.batch();
        for (const ref of stale.slice(i, i + 400)) batch.delete(ref);
        await batch.commit();
      }

      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      this.logger.log(
        `earnings: wrote ${docs.length} calendar rows (${from}..${to}), removed ${stale.length} stale`,
      );
      return { count: docs.length, removed: stale.length };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
