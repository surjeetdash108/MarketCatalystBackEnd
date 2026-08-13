import { Injectable, Logger } from "@nestjs/common";
import { TICKER_UNIVERSE } from "../common/ticker-universe";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";
import { PolygonService } from "../vendors/polygon/polygon.service";

/**
 * SEC-EDGAR 8-K ingestion → two live feeds, from ONE per-company submissions
 * fetch (same per-CIK pattern as sec-form4):
 *
 *  • filings "newswire"      — every recent 8-K (delivery-plan: News → wire).
 *  • earnings announcements  — 8-Ks carrying item 2.02 (Results of Operations),
 *                              the real earnings announcement. Adds the session
 *                              (BMO/AMC, from the SEC acceptance time) and the
 *                              post-announcement price reaction (computed live
 *                              from Polygon daily bars) that Polygon alone can't
 *                              give from the filing.
 *
 * Live-direct: swept across the full ticker universe per request, no Firestore.
 */

const FILINGS_PER_COMPANY = 8;
const LOOKBACK_DAYS = 120;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/**
 * Session from the SEC acceptance timestamp. EDGAR reports the acceptance
 * wall-clock in US-Eastern; we read the HH:MM directly (avoiding TZ math):
 * before 09:30 → BMO, at/after 16:00 → AMC, otherwise intraday.
 */
function sessionFromAcceptance(
  acc?: string,
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

async function fetchTickerToCik(
  userAgent: string,
): Promise<Map<string, string>> {
  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": userAgent },
  });
  const data = (await res.json()) as Record<string, { ticker: string; cik_str: string | number }>;
  const map = new Map<string, string>();
  for (const entry of Object.values(data)) {
    map.set(entry.ticker.toUpperCase(), String(entry.cik_str));
  }
  return map;
}

@Injectable()
export class Edgar8KJob {
  private readonly logger = new Logger(Edgar8KJob.name);

  constructor(
    private readonly secEdgar: SecEdgarService,
    private readonly polygon: PolygonService,
  ) {}

  /**
   * Post-announcement % move around `announceDate`, direction-aware by session.
   * Computed LIVE from Polygon daily bars in a window bracketing the
   * announcement (the served `ohlcv_bars` cache is gone). Any failure degrades
   * to null rather than dropping the whole announcement.
   */
  private async reactionPct(
    ticker: string,
    announceDate: string,
    session: "BMO" | "AMC" | "Intraday" | null,
  ): Promise<number | null> {
    try {
      const from = isoDate(addDays(new Date(announceDate), -7));
      const to = isoDate(addDays(new Date(announceDate), 7));
      const raw = await this.polygon.getAggsRange(ticker, from, to);
      const bars = raw
        .map((b) => ({ barDate: isoDate(new Date(b.t)), close: b.c }))
        .filter((b) => typeof b.close === "number")
        .sort((a, b) => a.barDate.localeCompare(b.barDate)); // ascending
      if (bars.length < 2) return null;
      let idx = bars.findIndex((b) => b.barDate >= announceDate);
      if (idx === -1) idx = bars.length - 1;
      // AMC news lands after the close → next session reacts. Otherwise the move
      // is prior-close → announcement-day close.
      if (session === "AMC") {
        const base = bars[idx]?.close;
        const next = bars[idx + 1]?.close;
        if (base != null && base > 0 && next != null)
          return ((next - base) / base) * 100;
        return null;
      }
      const prev = bars[idx - 1]?.close;
      const cur = bars[idx]?.close;
      if (prev != null && prev > 0 && cur != null)
        return ((cur - prev) / prev) * 100;
      return null;
    } catch (err) {
      this.logger.warn(
        `reaction calc failed for ${ticker} ${announceDate}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Build the 8-K wire + earnings-announcement docs for ONE company. */
  private async processTicker(
    ticker: string,
    cik: string,
    cutoff: string,
  ): Promise<{
    wire: { id: string; data: Record<string, unknown> }[];
    ann: { id: string; data: Record<string, unknown> }[];
  }> {
    const wire: { id: string; data: Record<string, unknown> }[] = [];
    const ann: { id: string; data: Record<string, unknown> }[] = [];
    try {
      const { name, recentFilings } = await this.secEdgar.getSubmissions(cik);
      const eightKs = recentFilings
        .filter((f) => f.form === "8-K" && f.filingDate >= cutoff)
        .slice(0, FILINGS_PER_COMPANY);
      for (const f of eightKs) {
        const announceDate = f.reportDate || f.filingDate;
        const session = sessionFromAcceptance(f.acceptanceDateTime);
        const items = f.items ?? "";
        const hasResults = /(^|[^\d])2\.02([^\d]|$)/.test(items);
        const accNoDash = f.accessionNumber.replace(/-/g, "");
        const url = `https://www.sec.gov/Archives/edgar/data/${cik.replace(/\D/g, "")}/${accNoDash}/${f.primaryDocument}`;

        wire.push({
          id: f.accessionNumber,
          data: {
            ticker,
            companyName: name ?? ticker,
            form: f.form,
            filingDate: f.filingDate,
            announceDate,
            acceptanceDateTime: f.acceptanceDateTime ?? null,
            items: items || null,
            session,
            isEarnings: hasResults,
            description: f.primaryDocDescription ?? "8-K",
            url,
            updatedAt: new Date().toISOString(),
          },
        });

        if (hasResults) {
          const reactionPct = await this.reactionPct(
            ticker,
            announceDate,
            session,
          );
          ann.push({
            id: `${ticker}_${announceDate}`,
            data: {
              ticker,
              companyName: name ?? ticker,
              announceDate,
              session,
              reactionPct:
                reactionPct == null
                  ? null
                  : Math.round(reactionPct * 100) / 100,
              accessionNumber: f.accessionNumber,
              url,
              updatedAt: new Date().toISOString(),
            },
          });
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed syncing 8-K for ${ticker}: ${(err as Error).message}`,
      );
    }
    return { wire, ann };
  }

  /**
   * Sweep a list of tickers and return both 8-K outputs. Used by `run()`
   * (cursor batch) and the live-direct fetch (full universe).
   */
  private async sweep(tickers: string[]): Promise<{
    wireDocs: { id: string; data: Record<string, unknown> }[];
    annDocs: { id: string; data: Record<string, unknown> }[];
  }> {
    const tickerToCik = await fetchTickerToCik(
      "Market Catalyst Backend hello@inc108.com",
    );
    const cutoff = isoDate(addDays(new Date(), -LOOKBACK_DAYS));
    const wireDocs: { id: string; data: Record<string, unknown> }[] = [];
    const annDocs: { id: string; data: Record<string, unknown> }[] = [];
    for (const ticker of tickers) {
      const cik = tickerToCik.get(ticker);
      if (!cik) {
        this.logger.warn(`No CIK found for ${ticker} — skipping 8-K lookup`);
        continue;
      }
      const { wire, ann } = await this.processTicker(ticker, cik, cutoff);
      wireDocs.push(...wire);
      annDocs.push(...ann);
    }
    return { wireDocs, annDocs };
  }

  /**
   * Live-direct: the recent-8-K filings "newswire" (`filings_wire` shape),
   * swept across the FULL ticker universe per request WITHOUT writing Firestore.
   * Backs GET /market-data/filings-wire. (A full SEC sweep is slow — accepted
   * for a live read that must reproduce the whole collection.)
   */
  async fetchFilingsWireLive(): Promise<Record<string, unknown>[]> {
    const { wireDocs } = await this.sweep([...TICKER_UNIVERSE]);
    return wireDocs.map((d) => ({ id: d.id, ...d.data }));
  }

  /**
   * Live-direct: 8-K item-2.02 earnings announcements (`earnings_announcements`
   * shape), swept across the FULL ticker universe per request WITHOUT writing
   * Firestore. Backs GET /market-data/earnings-announcements. The reaction %
   * still reads `ohlcv_bars` (an existing enrichment, not the served cache).
   */
  async fetchEarningsAnnouncementsLive(): Promise<Record<string, unknown>[]> {
    const { annDocs } = await this.sweep([...TICKER_UNIVERSE]);
    return annDocs.map((d) => ({ id: d.id, ...d.data }));
  }
}
