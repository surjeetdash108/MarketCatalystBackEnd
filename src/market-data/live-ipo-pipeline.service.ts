import { Injectable } from "@nestjs/common";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the `edgar-ipo-pipeline` sync job + Firestore cache. The
 * upcoming-IPO table needs companies that have REGISTERED but not yet listed —
 * these filers aren't in our traded ticker universe, so the per-CIK submissions
 * API can't reach them. Instead we read EDGAR's quarterly pipe-delimited
 * full-index `master.idx` (CIK|Company|Form|Date Filed|Filename) and keep recent
 * S-1/424B registration filings. Parse + shape preserved verbatim from
 * `sync/edgar-ipo-pipeline.job.ts`.
 *
 * Caveat (unchanged): master.idx lists every S-1 (incl. shells, SPACs, secondary
 * offerings, amendments), so this is the raw registration pipeline, not a
 * curated IPO list.
 *
 * Reuse window: 10 min. master.idx is a large whole-quarter index and IPO
 * registrations are daily-cadence, so a longer in-memory coalesce keeps us from
 * re-pulling a multi-MB index on every IPO-screen visit while staying far
 * fresher than the data changes. Still no cache/cron; still SEC-throttled via
 * SecEdgarService's shared ≥150ms gap.
 */

const RECENT_DAYS = 60;
const MAX_DOCS = 400;
const REUSE_MS = 600_000;
const TARGET_FORMS = new Set([
  "S-1",
  "S-1/A",
  "424B4",
  "424B3",
  "F-1",
  "F-1/A",
]);

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function quarterOf(month0: number): number {
  return Math.floor(month0 / 3) + 1;
}

@Injectable()
export class LiveIpoPipelineService {
  private readonly coalescer = new LiveCoalescer(REUSE_MS);

  constructor(private readonly secEdgar: SecEdgarService) {}

  async getIpoPipeline() {
    return this.coalescer.run("ipo-pipeline", async () => {
      const now = new Date();
      const cutoff = isoDate(new Date(now.getTime() - RECENT_DAYS * 86_400_000));
      const year = now.getUTCFullYear();
      const qtr = quarterOf(now.getUTCMonth());

      // Current quarter, plus the previous one early in a quarter so the recent
      // window is always covered.
      const sources = [{ year, qtr }];
      if (now.getUTCDate() <= 25) {
        const prevQtr = qtr === 1 ? 4 : qtr - 1;
        const prevYear = qtr === 1 ? year - 1 : year;
        sources.push({ year: prevYear, qtr: prevQtr });
      }

      const seen = new Set<string>();
      const docs: { id: string; [k: string]: unknown }[] = [];
      for (const s of sources) {
        const text = await this.secEdgar.fetchFullIndexMasterIdx(s.year, s.qtr);
        if (!text) continue;
        for (const line of text.split("\n")) {
          // Data rows have exactly the 5 pipe-delimited columns.
          const parts = line.split("|");
          if (parts.length !== 5) continue;
          const [cik, company, form, dateFiled, filename] = parts.map((p) =>
            p.trim(),
          );
          if (!TARGET_FORMS.has(form)) continue;
          if (!dateFiled || dateFiled < cutoff) continue;
          const accession =
            filename
              .split("/")
              .pop()
              ?.replace(/\.txt$/, "") ?? filename;
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

      // Newest first, capped.
      docs.sort((a, b) =>
        String(b.dateFiled).localeCompare(String(a.dateFiled)),
      );
      return docs.slice(0, MAX_DOCS);
    });
  }
}
