import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { chunkedBatchSet } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { SyncRegistry } from '../common/sync-registry.service';

/**
 * SEC-EDGAR registration pipeline → `ipo_pipeline`. The upcoming-IPO table needs
 * companies that have REGISTERED but not yet listed — these filers aren't in our
 * traded ticker universe, so the per-CIK submissions API (sec-form4 / edgar-8k)
 * can't reach them. Instead we read EDGAR's quarterly pipe-delimited full-index
 * `master.idx` (CIK|Company|Form|Date Filed|Filename) and keep recent S-1/424B
 * registration filings.
 *
 * Caveat: master.idx lists every S-1 (incl. shells, SPACs, secondary offerings,
 * amendments), so this is the raw registration pipeline, not a curated IPO list.
 */

const JOB_NAME = 'edgar-ipo-pipeline';
const USER_AGENT = 'Market Catalyst Backend hello@inc108.com';
const RECENT_DAYS = 60;
const MAX_DOCS = 400;
const TARGET_FORMS = new Set(['S-1', 'S-1/A', '424B4', '424B3', 'F-1', 'F-1/A']);

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function quarterOf(month0: number): number {
  return Math.floor(month0 / 3) + 1;
}

@Injectable()
export class EdgarIpoPipelineJob implements OnModuleInit {
  private readonly logger = new Logger(EdgarIpoPipelineJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['ipo_pipeline'],
      cronExpression: '0 8 * * 1-5', // runs inside premarket orchestration
      timeZone: 'America/New_York',
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  private async fetchMasterIdx(year: number, qtr: number): Promise<string | null> {
    const url = `https://www.sec.gov/Archives/edgar/full-index/${year}/QTR${qtr}/master.idx`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      this.logger.warn(`master.idx ${year} QTR${qtr} -> ${res.status}`);
      return null;
    }
    return res.text();
  }

  async run() {
    try {
      const now = new Date();
      const cutoff = isoDate(new Date(now.getTime() - RECENT_DAYS * 86_400_000));
      const year = now.getUTCFullYear();
      const qtr = quarterOf(now.getUTCMonth());

      // Current quarter, plus the previous one early in a quarter so the recent
      // window is always covered.
      const sources = [{ year, qtr }];
      if (now.getUTCDate() <= 25 && qtr === quarterOf(now.getUTCMonth())) {
        const prevQtr = qtr === 1 ? 4 : qtr - 1;
        const prevYear = qtr === 1 ? year - 1 : year;
        sources.push({ year: prevYear, qtr: prevQtr });
      }

      const seen = new Set<string>();
      const docs: { id: string; data: Record<string, unknown> }[] = [];
      for (const s of sources) {
        const text = await this.fetchMasterIdx(s.year, s.qtr);
        if (!text) continue;
        const lines = text.split('\n');
        for (const line of lines) {
          // Data rows have exactly the 5 pipe-delimited columns.
          const parts = line.split('|');
          if (parts.length !== 5) continue;
          const [cik, company, form, dateFiled, filename] = parts.map((p) => p.trim());
          if (!TARGET_FORMS.has(form)) continue;
          if (!dateFiled || dateFiled < cutoff) continue;
          const accession = filename.split('/').pop()?.replace(/\.txt$/, '') ?? filename;
          const id = `${cik}_${accession}`;
          if (seen.has(id)) continue;
          seen.add(id);
          docs.push({
            id,
            data: {
              cik,
              companyName: company,
              form,
              dateFiled,
              accessionNumber: accession,
              url: `https://www.sec.gov/Archives/${filename}`,
              updatedAt: new Date().toISOString(),
            },
          });
        }
      }

      // Newest first, capped.
      docs.sort((a, b) => String(b.data.dateFiled).localeCompare(String(a.data.dateFiled)));
      const capped = docs.slice(0, MAX_DOCS);

      await chunkedBatchSet(this.firebase.firestore, 'ipo_pipeline', capped);
      await this.meta.record(JOB_NAME, { ok: true, count: capped.length });
      this.logger.log(`edgar-ipo-pipeline: wrote ${capped.length} registration filing(s)`);
      return { count: capped.length };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
