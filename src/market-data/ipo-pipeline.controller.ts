import { Controller, Get, Header, Logger } from '@nestjs/common';

/**
 * GET /market-data/ipo-pipeline — recent SEC-EDGAR S-1/424B registration
 * filings. Fetches EDGAR's quarterly `master.idx` full-index directly on
 * every request (no Firestore cache, no sync job) — mirrors
 * edgar-ipo-pipeline.job.ts's fetch + parse/filter/dedup/sort, minus
 * persistence. See that job for why `master.idx` rather than a per-ticker
 * submissions call: these filers haven't listed yet, so they aren't in the
 * traded ticker universe.
 */
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

@Controller('market-data')
export class IpoPipelineController {
  private readonly logger = new Logger(IpoPipelineController.name);

  private async fetchMasterIdx(year: number, qtr: number): Promise<string | null> {
    const url = `https://www.sec.gov/Archives/edgar/full-index/${year}/QTR${qtr}/master.idx`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      this.logger.warn(`master.idx ${year} QTR${qtr} -> ${res.status}`);
      return null;
    }
    return res.text();
  }

  @Get('ipo-pipeline')
  @Header('Cache-Control', 'no-store')
  async ipoPipeline() {
    const now = new Date();
    const cutoff = isoDate(new Date(now.getTime() - RECENT_DAYS * 86_400_000));
    const year = now.getUTCFullYear();
    const qtr = quarterOf(now.getUTCMonth());

    const sources = [{ year, qtr }];
    if (now.getUTCDate() <= 25) {
      const prevQtr = qtr === 1 ? 4 : qtr - 1;
      const prevYear = qtr === 1 ? year - 1 : year;
      sources.push({ year: prevYear, qtr: prevQtr });
    }

    const seen = new Set<string>();
    const docs: Record<string, unknown>[] = [];
    for (const s of sources) {
      const text = await this.fetchMasterIdx(s.year, s.qtr);
      if (!text) continue;
      const lines = text.split('\n');
      for (const line of lines) {
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
          cik,
          companyName: company,
          form,
          dateFiled,
          accessionNumber: accession,
          url: `https://www.sec.gov/Archives/${filename}`,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    docs.sort((a, b) => String(b.dateFiled).localeCompare(String(a.dateFiled)));
    return docs.slice(0, MAX_DOCS);
  }
}
