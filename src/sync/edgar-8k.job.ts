import { getTickerToCik } from "../common/sec-cik-map.util";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { readGuidance } from "../common/guidance.util";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { TICKER_UNIVERSE } from "../common/ticker-universe";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { addDays, isoDate } from "../common/date.util";

/**
 * SEC-EDGAR 8-K ingestion → two collections, from ONE per-company submissions
 * fetch (same per-CIK pattern as sec-form4):
 *
 *  • `filings_wire/{accession}`      — every recent 8-K as a filings "newswire"
 *                                      item (delivery-plan: News → filings wire).
 *  • `earnings_announcements/{ticker}_{date}` — 8-Ks carrying item 2.02 (Results
 *                                      of Operations), the real earnings
 *                                      announcement. Adds the session (BMO/AMC,
 *                                      from the SEC acceptance time) and the
 *                                      post-announcement price reaction (from
 *                                      ohlcv_bars) that Polygon alone can't give.
 *
 * Cursor-batched across the ticker universe so each run is bounded; docs are
 * keyed idempotently (accession / ticker_date), so re-runs upsert.
 */

const JOB_NAME = "edgar-8k";
const BATCH_SIZE = 20;
const FILINGS_PER_COMPANY = 8;
const LOOKBACK_DAYS = 120;


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


@Injectable()
export class Edgar8KJob implements OnModuleInit {
  private readonly logger = new Logger(Edgar8KJob.name);

  constructor(
    private readonly secEdgar: SecEdgarService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["filings_wire", "earnings_announcements"],
      cronExpression: "0 8 * * 1-5", // runs inside premarket orchestration
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  /**
   * Post-announcement % move around `announceDate`, direction-aware by session.
   * Uses the EXISTING (ticker ASC, barDate DESC) composite index — `barDate <=`
   * + `orderBy barDate desc`, then reversed in memory — so no new index is
   * required. Any query failure degrades to null rather than dropping the whole
   * announcement.
   */
  private async reactionPct(
    ticker: string,
    announceDate: string,
    session: "BMO" | "AMC" | "Intraday" | null,
  ): Promise<number | null> {
    try {
      const to = isoDate(addDays(new Date(announceDate), 7));
      const snap = await this.firebase.firestore
        .collection("ohlcv_bars")
        .where("ticker", "==", ticker)
        .where("barDate", "<=", to)
        .orderBy("barDate", "desc")
        .limit(20)
        .get();
      const bars = (
        snap.docs
          .map((d) => d.data())
          .filter((b) => typeof b.close === "number") as {
          barDate: string;
          close: number;
        }[]
      ).reverse(); // ascending
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

  async run() {
    try {
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from(
        { length: BATCH_SIZE },
        (_, i) => TICKER_UNIVERSE[(cursor + i) % TICKER_UNIVERSE.length],
      );
      const tickerToCik = await getTickerToCik(
        this.firebase.firestore,
        "Market Catalyst Backend hello@inc108.com",
      );
      const cutoff = isoDate(addDays(new Date(), -LOOKBACK_DAYS));

      const wireDocs: { id: string; data: Record<string, unknown> }[] = [];
      const annDocs: { id: string; data: Record<string, unknown> }[] = [];

      for (const ticker of batch) {
        const cik = tickerToCik.get(ticker);
        if (!cik) {
          this.logger.warn(`No CIK found for ${ticker} — skipping 8-K lookup`);
          continue;
        }
        try {
          const { name, recentFilings } =
            await this.secEdgar.getSubmissions(cik);
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

            wireDocs.push({
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
              // Company guidance lives in the 8-K's earnings press release
              // (exhibit 99.x), not in any vendor feed. Best-effort: a fetch or
              // parse failure must not lose the announcement itself, which is
              // what the earnings hub depends on.
              let guidance: ReturnType<typeof readGuidance> | null = null;
              try {
                const release = await this.secEdgar.getEarningsPressRelease(
                  cik,
                  f.accessionNumber,
                );
                if (release) guidance = readGuidance(release);
              } catch (e) {
                this.logger.warn(
                  `guidance: no press release for ${ticker} ${f.accessionNumber}: ${(e as Error).message}`,
                );
              }

              annDocs.push({
                id: `${ticker}_${announceDate}`,
                data: {
                  ticker,
                  companyName: name ?? ticker,
                  announceDate,
                  session,
                  // null direction is meaningful: the release discussed
                  // guidance but never said which way it moved (~44% of
                  // filings). The range is stored so direction can later be
                  // derived by diffing consecutive quarters.
                  guidanceDirection: guidance?.direction ?? null,
                  guidanceRange: guidance?.range ?? null,
                  guidanceSnippet: guidance?.snippet ?? null,
                  guidanceMentioned: guidance?.mentioned ?? false,
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
          this.logger.error(`Failed syncing 8-K for ${ticker}: ${err.message}`);
        }
      }

      await chunkedBatchSet(this.firebase.firestore, "filings_wire", wireDocs);
      await chunkedBatchSet(
        this.firebase.firestore,
        "earnings_announcements",
        annDocs,
      );
      await this.meta.setCursor(
        JOB_NAME,
        (cursor + BATCH_SIZE) % TICKER_UNIVERSE.length,
      );
      await this.meta.record(JOB_NAME, { ok: true, count: wireDocs.length });
      this.logger.log(
        `edgar-8k: ${wireDocs.length} filings, ${annDocs.length} earnings announcements (cursor ${cursor})`,
      );
      return { filings: wireDocs.length, announcements: annDocs.length };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
