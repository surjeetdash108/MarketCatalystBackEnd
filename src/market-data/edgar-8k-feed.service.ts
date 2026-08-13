import { Injectable } from "@nestjs/common";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Session from the SEC acceptance timestamp — see edgar-8k.job.ts for why this
 * reads the ET HH:MM directly rather than doing TZ math (EDGAR reports the
 * acceptance time in ET). Before 09:30 → BMO, at/after 16:00 → AMC, else intraday.
 */
function sessionFromAcceptance(
  acc?: string | null,
): "BMO" | "AMC" | "Intraday" | null {
  if (!acc || acc.length < 16) return null;
  const hh = Number(acc.slice(11, 13));
  const mm = Number(acc.slice(14, 16));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const mins = hh * 60 + mm;
  if (mins < 9 * 60 + 30) return "BMO";
  if (mins >= 16 * 60) return "AMC";
  return "Intraday";
}

export interface WireDoc {
  id: string;
  ticker: string;
  companyName: string;
  form: string;
  filingDate: string;
  announceDate: string;
  acceptanceDateTime: string | null;
  items: string | null;
  session: "BMO" | "AMC" | "Intraday" | null;
  isEarnings: boolean;
  description: string;
  url: string;
  updatedAt: string;
}

export interface AnnouncementSeed {
  ticker: string;
  companyName: string;
  announceDate: string;
  session: "BMO" | "AMC" | "Intraday" | null;
  accessionNumber: string;
  url: string;
}

/**
 * Shared live fetch for filings-wire.controller.ts and
 * earnings-announcements.controller.ts.
 *
 * Live replacement for the `edgar-8k` sync job + Firestore cache. The job
 * crawled every ticker's submissions (241 CIKs × ≥150ms ≈ 36s — too slow for a
 * live request). Instead this reads EDGAR's market-wide "latest filings"
 * (getcurrent) 8-K stream in ONE call, then resolves each filer's CIK → ticker
 * (dropping untraded shells/SPACs with no ticker). Both consumers read the same
 * fetch, so it lives here once and is coalesced (60s reuse: 8-Ks stream
 * continuously but re-pulling on every dashboard/recap/earnings view is wasteful;
 * still an in-memory window, no cache/cron).
 *
 * Tradeoff vs the old crawl: getcurrent returns only the most RECENT ~100 8-Ks
 * market-wide (a live newswire), not a 120-day per-ticker history. The
 * post-announcement price REACTION the job computed from stored bars is dropped
 * (null) — it needs accumulated bars no single live call provides (see
 * live-earnings-announcements.service.ts).
 */
const FEED_COUNT = 100;
const REUSE_MS = 60_000;

@Injectable()
export class Edgar8kFeedService {
  private readonly coalescer = new LiveCoalescer(REUSE_MS);

  constructor(private readonly secEdgar: SecEdgarService) {}

  async fetchAll(): Promise<{
    wireDocs: WireDoc[];
    announcements: AnnouncementSeed[];
  }> {
    return this.coalescer.run("edgar-8k-feed", async () => {
      const [filings, cikToTicker] = await Promise.all([
        this.secEdgar.fetchLatestFilings("8-K", FEED_COUNT),
        this.secEdgar.getCikToTicker(),
      ]);

      const wireDocs: WireDoc[] = [];
      const announcements: AnnouncementSeed[] = [];
      const now = new Date().toISOString();

      for (const f of filings) {
        if (f.form !== "8-K") continue;
        const ticker = cikToTicker.get(f.cik);
        if (!ticker) continue; // untraded filer — not shown on tradeable screens

        const session = sessionFromAcceptance(f.acceptanceDateTime);
        const isEarnings = /(^|,)2\.02(,|$)/.test(f.items);
        const announceDate = f.filingDate;

        wireDocs.push({
          id: f.accessionNumber || `${f.cik}_${f.filingDate}`,
          ticker,
          companyName: f.companyName || ticker,
          form: f.form,
          filingDate: f.filingDate,
          announceDate,
          acceptanceDateTime: f.acceptanceDateTime,
          items: f.items || null,
          session,
          isEarnings,
          description: "8-K",
          url: f.indexUrl,
          updatedAt: now,
        });

        if (isEarnings) {
          announcements.push({
            ticker,
            companyName: f.companyName || ticker,
            announceDate,
            session,
            accessionNumber: f.accessionNumber,
            url: f.indexUrl,
          });
        }
      }

      return { wireDocs, announcements };
    });
  }
}
