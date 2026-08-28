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
/**
 * Round-robin slice per run, on top of the prioritised reporters.
 *
 * Sized from measurement, not guessed: a 20-ticker run takes 12-19s (two SEC
 * requests per ticker at the vendor's 150ms floor, ~0.75s each), against Cloud
 * Run's 900s request timeout — this job runs inline, so that timeout is the
 * real ceiling, not the scheduler's deadline. 60 puts a run near 45s and walks
 * the 241-ticker universe in about two days instead of six.
 */
const BATCH_SIZE = 60;
/**
 * Hard cap on the whole batch. During peak earnings season the prioritised
 * reporters alone can be large, and reporters + round-robin must not drift
 * toward the request timeout. 150 tickers is roughly two minutes.
 */
const MAX_BATCH = 150;
/**
 * How far back to look for reporters still missing guidance.
 *
 * Weekdays stay tight — the point of a weekday run is the companies that
 * reported today, and the market-hours jobs are competing for the same worker.
 *
 * Weekends sweep the whole quarter instead. Guidance is IMMUTABLE once the 8-K
 * is filed, so a past reporter never needs re-reading: the weekend pass fills
 * the quarter once and the "already have an announcement" check then costs two
 * queries a run. Nothing else contends for the worker on a Saturday, and it
 * leaves weekdays with only the day's own reporters to top up.
 */
const WEEKDAY_LOOKBACK_DAYS = 4;
const WEEKEND_LOOKBACK_DAYS = 100; // superseded on weekends by the quarter window
/**
 * A report filed this many days either side of a calendar earnings date is
 * taken to BE that report. After-close reporters file the next morning, and
 * vendors and the SEC occasionally disagree by a day.
 */
const MATCH_WINDOW_DAYS = 3;
/**
 * For a company that has not reported yet, "we already have its guidance"
 * means a filing within roughly the last quarter — the guidance it issued at
 * its previous report, which is the forward view for the one coming.
 */
const PRIOR_FILING_DAYS = 120;

/**
 * How far FORWARD the weekend sweep also looks.
 *
 * A company on next month's calendar already has guidance — the guidance it
 * issued at its LAST report, which is precisely the forward view for the
 * quarter it is about to report on. Fetching it in advance means the Earnings
 * Hub can show guidance for an upcoming date instead of a column of dashes
 * until the company files.
 *
 * Reachable because the filing search looks back LOOKBACK_DAYS (120) — more
 * than a quarter — so an upcoming reporter's previous 8-K is still in range.
 */
const WEEKEND_LOOKAHEAD_DAYS = 100;
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


/**
 * [start of this calendar quarter, end of the next one] as ISO dates.
 * Anchored on quarter boundaries so the weekend sweep aims at a fixed target
 * rather than a window that slides a day every run.
 */
function twoQuarterWindow(now: Date): [string, string] {
  const y = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3);
  const start = new Date(Date.UTC(y, q * 3, 1));
  // First day of the quarter after next, minus one day.
  const end = new Date(Date.UTC(y, q * 3 + 6, 1) - 86_400_000);
  return [isoDate(start), isoDate(end)];
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
      // 08:00 sweeps overnight filings; 17:30 and 20:00 catch the same-evening
    // item-2.02 8-K that an after-close reporter files within ~30 minutes of
    // its release. That filing is where the guidance and the session/reaction
    // come from, so a morning-only sweep left them a day behind the print.
    cronExpression: "0 8,17,20 * * 1-5", // runs inside premarket orchestration
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

  /**
   * Companies that reported recently and do NOT yet have an announcement on
   * file — i.e. the ones whose guidance is still missing.
   *
   * NOT limited to TICKER_UNIVERSE. The universe is the watchlist the filings
   * WIRE follows (241 names); the earnings calendar is far wider — a busy
   * session has 616 reporters and a peak week 1,752. Guidance is wanted for
   * whoever is on the calendar that day, not only for watched names.
   *
   * Nor can they all be fetched at once: at ~0.75s a ticker, a peak window
   * would take ~1,050s against Cloud Run's 900s request timeout, which binds
   * because this job runs inline. So each run takes the ones still missing, up
   * to the cap, and subsequent runs chip away at the remainder until the window
   * is covered — after which this returns nothing and the run costs only the
   * two queries below.
   */
  private async reportersNeedingGuidance(): Promise<string[]> {
    const now = new Date();
    const dow = now.getUTCDay();
    const weekend = dow === 0 || dow === 6;

    // Weekends cover THIS calendar quarter and the NEXT one, anchored on the
    // quarter boundaries rather than a rolling window, so the target is stable
    // all week instead of sliding a day at a time. Weekdays stay tight: the
    // day's own reporters, nothing more.
    const [since, until] = weekend
      ? twoQuarterWindow(now)
      : [isoDate(addDays(now, -WEEKDAY_LOOKBACK_DAYS)), isoDate(now)];

    try {
      const db = this.firebase.firestore;
      // Announcements are read from a quarter BEFORE the window: an upcoming
      // reporter's guidance was filed at its previous report, which sits
      // outside the window it appears in.
      const annSince = isoDate(addDays(new Date(since), -PRIOR_FILING_DAYS));
      const [events, have] = await Promise.all([
        db.collection("earnings_events")
          .where("date", ">=", since).where("date", "<=", until).get(),
        db.collection("earnings_announcements")
          .where("announceDate", ">=", annSince).where("announceDate", "<=", until).get(),
      ]);

      const annByTicker = new Map<string, string[]>();
      for (const d of have.docs) {
        const x = d.data();
        const t = x.ticker as string | undefined;
        const a = x.announceDate as string | undefined;
        if (!t || !a) continue;
        (annByTicker.get(t) ?? annByTicker.set(t, []).get(t)!).push(a);
      }

      const today = isoDate(now);
      const days = (a: string, b: string) =>
        Math.abs(
          (new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / 86_400_000,
        );

      const missing = new Set<string>();
      for (const d of events.docs) {
        const x = d.data();
        const t = x.ticker as string | undefined;
        const date = x.date as string | undefined;
        if (!t || !date) continue;
        const filed = annByTicker.get(t) ?? [];

        // Two different questions, depending on whether the report has happened.
        //
        // Already reported: do we have the filing FOR THAT REPORT? Asking only
        // "does this ticker have any filing" was wrong — a company with a July
        // 8-K would have counted as covered when it reported again in October,
        // and its new guidance would never have been fetched.
        //
        // Not reported yet: nothing exists for it, so the question is whether
        // we hold its PREVIOUS filing — that is the guidance to show for the
        // quarter it is about to report on.
        const covered =
          date <= today
            ? filed.some((a) => days(a, date) <= MATCH_WINDOW_DAYS)
            : filed.some((a) => a <= today && days(today, a) <= PRIOR_FILING_DAYS);

        if (!covered) missing.add(t);
      }
      // Sorted so successive runs walk the same order and converge, rather
      // than re-drawing an arbitrary slice of the same set each time.
      return [...missing].sort();
    } catch (err) {
      // Never let this stop the filings wire — fall back to the round-robin.
      this.logger.warn(`edgar-8k: could not read recent reporters: ${(err as Error).message}`);
      return [];
    }
  }

  async run() {
    try {
      const cursor = await this.meta.getCursor(JOB_NAME);

      /**
       * Companies that JUST REPORTED come first; the round-robin fills the rest.
       *
       * The cursor alone walks 20 tickers a run, twice a weekday — 40 of a
       * 241-ticker universe per day, so any one company's filings were read
       * about once every six trading days. That is fine for the filings wire,
       * which is a rolling feed, but it is useless for guidance: guidance is
       * only published in the earnings 8-K, and by the time the cursor reached
       * a company its results were a week old and nobody was looking at that
       * day any more. Measured: the newest earnings announcement on file was
       * two days behind the calendar during earnings season.
       *
       * Reporters are also the cheaper set to check — a company that did not
       * report has no earnings 8-K to find.
       */
      const recent = await this.reportersNeedingGuidance();
      const roundRobin = Array.from(
        { length: BATCH_SIZE },
        (_, i) => TICKER_UNIVERSE[(cursor + i) % TICKER_UNIVERSE.length],
      );
      // Reporters first, then the round-robin, de-duplicated so a company that
      // is in both is not fetched twice in one run.
      // Reporters keep their priority when the cap bites — they are the ones
      // guidance depends on; the wire catches up on the next run.
      const batch = [...new Set([...recent, ...roundRobin])].slice(0, MAX_BATCH);
      if (recent.length) {
        this.logger.log(
          `edgar-8k: ${recent.length} reporter(s) still missing guidance, ` +
            `${Math.min(recent.length, MAX_BATCH)} taken this run + ${roundRobin.length} from the cursor`,
        );
      }
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
